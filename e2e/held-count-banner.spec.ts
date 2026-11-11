import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE, superuserUrl } from '../scripts/db-bootstrap';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { withRlsContext } from '../src/lib/db/rls-context';
import { addDaysIso } from '../src/modules/ledger';
import { realClock, businessDateOf } from '../src/modules/clock';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, insertOrder, orderMaster } from '../tests/helpers/ledger-fixtures';
import { E2E_MD, loginAndEnrol, logout } from './fixtures';

// R18 group 4E: the office held-count banner with a SEEDED hold, and the HTTP/RSC answer holds the aggregate only. A driver declared the unloading of a
// rotation and the plant recorded no load: the office roles that work the invoice queue see "1" and nothing else — no order code, client, truck, driver,
// trip id or volume in the page, nor in the React Server Components payload that carries it.
test.describe.configure({ mode: 'serial' });
const env = testEnv(E2E_DATABASE);
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
test.afterAll(() => Promise.all([app.end(), migrator.end()]));

const needles: Record<string, string> = {};
let held0 = 0;

test.beforeAll(async () => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const marker = `e2ehb${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const master = await orderMaster(app, owner.id, marker);
  const scene = await deliveryScene(app, owner.id, marker);
  const day = addDaysIso(businessDateOf(realClock.now()), -1);
  const plantId = (
    await migrator.query<{ id: string }>(
      `select id from plant where status = 'active' order by created_at limit 1`,
    )
  ).rows[0]?.id;
  const driver = randomUUID();
  const trip = randomUUID();
  const order = await withRlsContext(
    app,
    { userId: owner.id, role: 'owner', requestId: marker },
    async (tx) => {
      if (plantId) await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
      const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, day);
      await tx.query(
        `insert into driver (id, code, name, created_by, kind) values ($1, 'CH-' || (6000 + floor(random() * 3000))::int, $2, $3, 'driver')`,
        [driver, `Chauffeur ${marker} FICTIF`, owner.id],
      );
      await tx.query(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, $6, 1000, 420, 430, 460, 500, 530, $7)`,
        [trip, randomUUID(), day, o.id, scene.truckId, driver, owner.id],
      );
      return o;
    },
  );
  const clientCode = (
    await migrator.query<{ code: string }>('select code from client where id = $1', [scene.clientId])
  ).rows[0]!.code;
  const truckPlate = (
    await migrator.query<{ plate: string }>('select plate from truck where id = $1', [scene.truckId])
  ).rows[0]!.plate;
  // the driver's stages up to a DECLARED end of the unloading, with no load recorded by the plant (a hold: declared_no_record). Written by hand with the
  // triggers off, as the old data of an installation would be.
  const sup = new pg.Client({ connectionString: superuserUrl(env, E2E_DATABASE) });
  await sup.connect();
  try {
    await sup.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
      SYSTEM_ACTOR_ID,
    ]);
    await sup.query('set session_replication_role = replica');
    for (const [i, step] of [
      'loading_started',
      'loaded',
      'departed',
      'arrived',
      'unloading_started',
      'unloading_finished',
    ].entries())
      await sup.query(
        `insert into trip_event (id, trip_id, step, at, created_by, source, actor_role, implicit) values (gen_random_uuid(), $1, $2, $3::timestamptz + ($4 || ' minutes')::interval, $5, 'driver', 'driver', false)`,
        [trip, step, `${day}T08:00:00Z`, String(i * 20), owner.id],
      );
  } finally {
    await sup.end();
  }
  Object.assign(needles, {
    orderCode: order.code,
    clientCode,
    truckPlate,
    trip,
    driver: `Chauffeur ${marker}`,
    orderId: order.id,
  });
  held0 = 1;
});

test('the office banner shows the seeded hold as a number, and the HTML and the RSC payload carry nothing but that number', async ({
  page,
  browser,
}) => {
  await loginAndEnrol(page, 'fr', E2E_MD.queueOffice.email);
  await page.goto('/fr/invoices/queue');
  const banner = page.getByTestId('queue-held');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/\d+ livraison/);
  const shown = Number(/(\d+)/.exec((await banner.textContent()) ?? '')?.[1]);
  expect(shown).toBeGreaterThanOrEqual(held0);
  await expect(page.getByTestId('queue-held-unavailable')).toHaveCount(0);

  // the same page over HTTP, as the browser's own session fetches it: the full HTML and the RSC payload (the Flight stream)
  const html = await page.request.get('/fr/invoices/queue');
  const rsc = await page.request.get('/fr/invoices/queue', {
    headers: { RSC: '1' },
  });
  for (const res of [html, rsc]) {
    expect(res.status()).toBe(200);
    const body = await res.text();
    for (const [what, needle] of Object.entries(needles))
      expect(body, `the response holds the ${what}`).not.toContain(needle);
    // no row of the detail reader travels with the page (its kinds as values, its ids as keys): the catalog's words are not data
    expect(body).not.toMatch(
      /\\?"kind\\?":\\?"(declared_no_record|unconfirmed|volume_differs|order_differs)/,
    );
    expect(body).not.toMatch(/\\?"(trip_id|tripId|plant_volume_l|declared_volume_l|planned_volume_l)\\?":/);
  }
  // the office cannot read the details at all
  for (const path of ['/fr/trips']) {
    const r = await page.request.get(path, { maxRedirects: 0 });
    expect([302, 303, 307, 308, 403, 404]).toContain(r.status());
  }
  await logout(page);
  void browser;
});
