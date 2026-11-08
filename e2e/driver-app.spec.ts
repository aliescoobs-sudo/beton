import { expect, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { setDriverPin } from '../src/modules/field';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, insertDelivery } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, loginAndEnrol } from './fixtures';

// R4 (AC-PROD-20 to 25): the driver's phone. Sign-in by code and PIN, one big button per step, taps queued offline and sent when
// the network returns, an emergency button with the options of the current step, never a price. Needs FIELD_APP_ENABLED (the e2e server).
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
test.afterAll(() => Promise.all([migrator.end(), app.end(), auth.end()]));

const marker = `e2edr${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const today = new Date().toISOString().slice(0, 10);
const code = `CH-${3000 + Math.floor(Math.random() * 900)}`;
const PIN = '482913';
let tripId = '';
let orderCode = '';

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const userId = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
     values ($1, $2, $3, true, 'driver', 'ar', 'active', false, now())`,
    [userId, `Chauffeur ${marker}`, `${marker}@field.kayas.invalid`],
  );
  const scene = await deliveryScene(app, owner.id, marker);
  const driverId = await withRlsContext(
    app,
    { userId: owner.id, role: 'owner', requestId: marker },
    async (tx) => {
      const d = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, user_id) values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
        [code, `Chauffeur ${marker}`, owner.id, userId],
      );
      const id = d.rows[0]!.id;
      const t = await tx.query<{ id: string }>(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, $4, 8000, 420, 430, 455, 485, 520, $5) returning id`,
        [today, scene.orderId, scene.truckId, id, owner.id],
      );
      tripId = t.rows[0]!.id;
      // the plant has loaded this rotation already (its BL), so the driver can depart
      const dl = await insertDelivery(tx, owner.id, scene, 8000);
      const delivery = (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [dl.blNo]))
        .rows[0]!.id;
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now() - interval '1 minute', $2, $3)`,
        [tripId, delivery, owner.id],
      );
      orderCode = (
        await tx.query<{ code: string }>('select code from sales_order where id = $1', [scene.orderId])
      ).rows[0]!.code;
      return id;
    },
  );
  const ok = await setDriverPin(
    { appPool: app, authPool: auth, auth: {} as never, secret: env.AUTH_SECRET },
    owner,
    { driverId, pin: PIN },
  );
  if (!ok.ok) throw new Error(ok.error);
});

// The driver is bound to one phone: every test uses the same device id, as one phone would (its local storage survives).
const DEVICE = 'e2e-phone-0123456789abcdef0123456789';
async function openAndSignIn(page: Page) {
  await page.addInitScript((id) => {
    if (!localStorage.getItem('bb_field_device')) localStorage.setItem('bb_field_device', id);
  }, DEVICE);
  await page.goto('/ar/driver');
  await page.getByTestId('field-code').or(page.getByTestId('field-day')).first().waitFor();
  if (await page.getByTestId('field-login').isVisible()) {
    await page.getByTestId('field-code').fill(code);
    await page.getByTestId('field-pin').fill(PIN);
    await page.getByTestId('field-signin').click();
  }
  await expect(page.getByTestId('field-day')).toBeVisible();
}

const stepsOf = async () =>
  (
    await migrator.query<{ step: string }>('select step from trip_event where trip_id = $1', [tripId])
  ).rows.map((r) => r.step);

test('a driver signs in with code and PIN, taps the steps, and never sees a price (Arabic)', async ({
  page,
}) => {
  await page.addInitScript((id) => {
    if (!localStorage.getItem('bb_field_device')) localStorage.setItem('bb_field_device', id);
  }, DEVICE);
  await page.goto('/ar/driver');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('field-code').fill(code);
  await page.getByTestId('field-pin').fill('918204');
  await page.getByTestId('field-signin').click();
  await expect(page.getByTestId('field-error')).toBeVisible();
  await page.getByTestId('field-pin').fill(PIN);
  await page.getByTestId('field-signin').click();
  await expect(page.getByTestId('field-day')).toBeVisible();
  const card = page.getByTestId(`trip-${orderCode}`);
  await expect(card).toBeVisible();

  // step 1 (the driver's own report), then the plant's load is there so departing is offered
  await page.getByTestId(`tap-${orderCode}`).click();
  await expect(page.getByTestId(`tap-${orderCode}`)).toContainText('غادرت الشاحنة المحطة');
  await page.getByTestId(`tap-${orderCode}`).click();
  await expect.poll(stepsOf).toContain('departed');
  const text = (await page.getByTestId('field-day').textContent()) ?? '';
  expect(text).not.toMatch(/MAD|DH|درهم|\d\s?\d{3},\d{2}/);
  // large type: the big button is at least 28 px
  const px = await page
    .getByTestId(`tap-${orderCode}`)
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(px).toBeGreaterThanOrEqual(28);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('taps made offline are queued and sent when the network returns, once', async ({ page, context }) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  await context.setOffline(true);
  await page.getByTestId(`tap-${orderCode}`).click();
  await expect(page.getByTestId('field-queued')).toBeVisible();
  await expect(page.getByTestId(`tap-${orderCode}`)).toContainText('بدأ التفريغ');
  expect(await stepsOf()).not.toContain('arrived');
  await context.setOffline(false);
  await expect.poll(stepsOf, { timeout: 60_000 }).toContain('arrived');
  await expect(page.getByTestId('field-queued')).toHaveCount(0, { timeout: 60_000 });
  expect((await stepsOf()).filter((s) => s === 'arrived')).toHaveLength(1);
});

test('the emergency button offers the options of the current step and alerts the office', async ({
  page,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  await page.getByTestId(`emergency-${orderCode}`).click();
  // at the site (arrived): no "load not enough", yes "site not ready"
  await expect(page.getByTestId('emergency-option-site_not_ready')).toBeVisible();
  await expect(page.getByTestId('emergency-option-load_not_enough')).toHaveCount(0);
  await page.getByTestId('emergency-option-site_not_ready').click();
  await expect
    .poll(
      async () =>
        (
          await migrator.query('select 1 from trip_emergency where trip_id = $1 and option = $2', [
            tripId,
            'site_not_ready',
          ])
        ).rowCount,
    )
    .toBe(1);
});

// A 1x1 PNG: the phone re-draws the picture as a JPEG before sending it.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('after the unloading the driver can send a photo of the signed BL, and the office opens it (C3)', async ({
  page,
  browser,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  await expect(page.getByTestId(`photo-${orderCode}`)).toHaveCount(0); // not before the m³ unloaded
  await page.getByTestId(`tap-${orderCode}`).click(); // unloading started
  await expect.poll(stepsOf).toContain('unloading_started');
  await page.getByTestId(`tap-${orderCode}`).click(); // unloading finished: asks the m³
  await page.getByTestId('field-m3').fill('7,5');
  await page.getByTestId('field-m3-ok').click();
  await expect(page.getByTestId(`photo-${orderCode}`)).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await migrator.query('select 1 from trip_driver_report where trip_id = $1 and kind = $2', [
            tripId,
            'unloaded',
          ])
        ).rowCount,
    )
    .toBe(1);
  await page
    .getByTestId(`photo-input-${orderCode}`)
    .setInputFiles({ name: 'bl.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(page.getByTestId(`photo-sent-${orderCode}`)).toBeVisible({ timeout: 60_000 });
  const stored = await migrator.query<{ id: string; content_type: string }>(
    'select id, content_type from driver_bl_photo where trip_id = $1',
    [tripId],
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]?.content_type).toBe('image/jpeg');
  // never a price on the driver's screen
  expect((await page.getByTestId('field-day').textContent()) ?? '').not.toMatch(/MAD|DH|درهم/);
  // the plant sees the link on the day's rotations and the file opens (checked route, audited)
  const office = await browser.newPage();
  await loginAndEnrol(office, 'fr', E2E_MD.driverPhotoPlant.email);
  await office.goto(`/fr/trips?date=${today}`);
  const link = office.getByTestId(`bl-photo-${stored.rows[0]!.id}`);
  await expect(link).toBeVisible();
  const res = await office.request.get(`/fr/trips/bl-photo/${stored.rows[0]!.id}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/jpeg');
  await office.close();
});

test('a wrong code is refused with no hint, and the app answers 404 on the pages of another locale it does not know', async ({
  request,
}) => {
  const res = await request.post('/api/field/login', {
    headers: { origin: 'http://localhost:3100', 'content-type': 'application/json' },
    data: { code: 'CH-9999', pin: '482913', deviceId: 'x'.repeat(32) },
  });
  expect(res.status()).toBe(401);
  const other = await request.post('/api/field/login', {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    data: { code, pin: PIN, deviceId: 'y'.repeat(32) },
  });
  expect(other.status()).toBe(403);
  const sync = await request.post('/api/field/sync', {
    headers: { origin: 'http://localhost:3100', 'content-type': 'application/json' },
    data: { actions: [] },
  });
  expect(sync.status()).toBe(401);
});

// F02 (final review): what the phone keeps for the road is tied to the account, limited in age, and erased on sign-out and on refusal.
/** The service worker controls the page and has the shell, so that an offline reload really opens the app and not the browser's error page. */
async function warmShell(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await page.getByTestId('field-code').or(page.getByTestId('field-day')).first().waitFor();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
const localState = (page: Page) =>
  page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    let photos = 0;
    if (dbs.some((d) => d.name === 'kayas-field')) {
      photos = await new Promise<number>((resolve) => {
        const req = indexedDB.open('kayas-field');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('photos')) return resolve(0);
          const c = db.transaction('photos').objectStore('photos').count();
          c.onsuccess = () => resolve(c.result);
        };
        req.onerror = () => resolve(-1);
      });
    }
    const cached: string[] = [];
    for (const k of await caches.keys())
      for (const r of await (await caches.open(k)).keys()) cached.push(r.url);
    return {
      day: localStorage.getItem('bb_field_day'),
      queue: localStorage.getItem('bb_field_queue'),
      photos,
      cached,
    };
  });

test('the day is never put in the service worker cache and is stored with its account (F02)', async ({
  page,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  const state = await localState(page);
  expect(state.cached.some((u) => u.includes('/api/field/session'))).toBe(false);
  const stored = JSON.parse(state.day!) as { userId: string; savedAt: number };
  expect(stored.userId).toMatch(/[0-9a-f-]{36}/);
  expect(Math.abs(Date.now() - stored.savedAt)).toBeLessThan(120_000);
});

test('signing out erases the day, the queue, the photos and the caches; offline, the phone shows the sign-in (F02)', async ({
  page,
  context,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  await page.getByTestId('field-signout').click();
  await expect(page.getByTestId('field-login')).toBeVisible();
  const state = await localState(page);
  expect(state.day).toBeNull();
  expect(state.queue).toBeNull();
  expect(state.photos).toBe(0);
  expect(state.cached.filter((u) => u.includes('/api/field/'))).toEqual([]);
  await warmShell(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('field-login')).toBeVisible();
  await expect(page.getByTestId(`trip-${orderCode}`)).toHaveCount(0);
  await expect(page.getByTestId('field-day')).toHaveCount(0);
  await context.setOffline(false);
});

test('a day older than the offline age is not shown offline, and a refused session wipes it (F02)', async ({
  page,
  context,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  // twenty hours old: past the 18 hours kept for the road
  await warmShell(page);
  await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('bb_field_day')!);
    {
      v.savedAt = Date.now() - 20 * 3600_000;
      localStorage.setItem('bb_field_day', JSON.stringify(v));
    }
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('field-login')).toBeVisible();
  expect((await localState(page)).day).toBeNull();
  await context.setOffline(false);

  // a session the server no longer accepts (cookie gone): the day is wiped at once, online
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  await context.clearCookies();
  await page.reload();
  await expect(page.getByTestId('field-login')).toBeVisible();
  expect((await localState(page)).day).toBeNull();
});

test('R11-06: a local tap does not extend the 18 hours, and a page left open crosses the limit by itself', async ({
  page,
  context,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  await warmShell(page);
  // the server last answered 17 h 59 min 40 s ago
  const readAt = await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('bb_field_day')!);
    v.savedAt = Date.now() - (18 * 3600_000 - 40_000);
    localStorage.setItem('bb_field_day', JSON.stringify(v));
    return v.savedAt as number;
  });
  await context.setOffline(true);
  // a tap on the phone changes the day shown, not the time the server vouched for it
  await page.getByTestId(`tap-${orderCode}`).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bb_field_day')!).savedAt)).toBe(readAt);
  // no reload, no tap: the page crosses 18 hours on its own and shows the sign-in, with nothing of the client left
  await expect(page.getByTestId('field-login')).toBeVisible({ timeout: 90_000 });
  expect((await localState(page)).day).toBeNull();
  await context.setOffline(false);
});

test('R12-04: the day leaves the screen at expiry even while the refresh is still pending', async ({
  page,
}) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  // from now on the server never answers a read of the day (a stalled connection, not a failed one)
  let held = 0;
  let answered = 0;
  await page.route('**/api/field/session', () => {
    held++; // never fulfilled, never continued
  });
  // the server last vouched for the day 18 h minus 25 s ago
  await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('bb_field_day')!);
    v.savedAt = Date.now() - (18 * 3600_000 - 25_000);
    localStorage.setItem('bb_field_day', JSON.stringify(v));
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/field/session')) answered++;
  });
  // the page crosses the limit by itself: the client's trip is gone from the screen and from the phone, with the read still pending
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeHidden({ timeout: 90_000 });
  expect((await localState(page)).day).toBeNull();
  expect(held).toBeGreaterThan(0);
  expect(answered).toBe(0);
  await expect(page.getByText(orderCode)).toHaveCount(0);
});

test('R11-06: a revoked session is found without any queued work', async ({ page, context }) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  // the day was read six minutes ago, nothing is waiting to be sent, and the server no longer accepts this phone
  await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('bb_field_day')!);
    v.savedAt = Date.now() - 6 * 60_000;
    localStorage.setItem('bb_field_day', JSON.stringify(v));
    localStorage.setItem('bb_field_queue', JSON.stringify({ userId: v.userId, actions: [] }));
  });
  await context.clearCookies();
  await expect(page.getByTestId('field-login')).toBeVisible({ timeout: 60_000 });
  expect((await localState(page)).day).toBeNull();
});

test('another account signing in on the phone finds nothing of the previous one (F02)', async ({ page }) => {
  await openAndSignIn(page);
  await expect(page.getByTestId(`trip-${orderCode}`)).toBeVisible();
  // the phone holds a queue and a day that belong to somebody else
  await page.evaluate(() => {
    localStorage.setItem(
      'bb_field_queue',
      JSON.stringify({
        userId: 'someone-else',
        actions: [
          {
            kind: 'step',
            key: 'foreign-tap-0001',
            tripId: 'x',
            step: 'arrived',
            at: new Date().toISOString(),
          },
        ],
      }),
    );
  });
  await page.reload();
  await expect(page.getByTestId('field-day')).toBeVisible();
  await expect
    .poll(async () => JSON.parse((await localState(page)).queue!).userId, { timeout: 15_000 })
    .not.toBe('someone-else');
  expect(JSON.parse((await localState(page)).queue!).actions).toEqual([]);
});
