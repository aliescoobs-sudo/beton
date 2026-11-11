import { expect, type Page, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { businessDateOf, realClock } from '../src/modules/clock';
import { setDriverPin } from '../src/modules/field';
import { createPlant, setPlantPhone, updatePlant } from '../src/modules/master-data';
import { clockOf } from '../src/modules/operations/domain/trip-times';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, insertOrder, orderMaster } from '../tests/helpers/ledger-fixtures';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { E2E_BASE_URL, E2E_MD, E2E_PASSWORD, loginAndEnrol, loginOwner } from './fixtures';

// T9, end to end: ONE status of a rotation, shown on the driver's phone and on the plant's board. The plant records "loaded" and the driver's
// screen shows it (by the Centrale); the driver departs without declaring the load and the plant's board shows loaded (implicit) and departed
// (by the Chauffeur); the plant manager corrects a time with a reason; a driver's tap changes no stock and delivers nothing until the plant
// confirms; an offline tap is queued, marked pending, and replayed once with its client time.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
test.afterAll(async () => {
  // the spec's plant must not stay active: with two active plants the later specs' orders would ask for a plant
  if (ownerSession && plantRowId) await updatePlant(app, ownerSession, plantRowId, { status: 'archived' });
  await Promise.all([migrator.end(), app.end(), auth.end()]);
});

const marker = `e2et9${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const today = businessDateOf(realClock.now());
const code = `CH-${5000 + Math.floor(Math.random() * 900)}`;
const PIN = '482913';
const DEVICE = 'e2e-t9-phone-0123456789abcdef01234567';
const SHOTS = '.logs/visual-checks';
let orderA = '';
let orderAId = '';
let orderB = '';
let orderC = '';
let orderD = '';
let tripA = '';
let tripB = '';
let tripC = '';
let tripD = '';
let truckCode = '';
let ownerId = '';
let ownerSession: Awaited<ReturnType<typeof realSessionUser>> | null = null;
let plantCode = '';
let plantRowId = '';

const stage = (page: Page, order: string, s: string) =>
  page.locator(`[data-testid="stages-${order}"] li[data-stage="${s}"]`);
const boardCard = (page: Page, order: string, load: number) =>
  page.getByTestId(`trip-${order}-${load}-${truckCode}`);
const boardStep = (page: Page, order: string, load: number, s: string) =>
  boardCard(page, order, load).locator(`li[data-step="${s}"]`);

async function phone(page: Page, locale = 'fr') {
  await page.addInitScript((id) => {
    if (!localStorage.getItem('bb_field_device')) localStorage.setItem('bb_field_device', id);
  }, DEVICE);
  await page.goto(`/${locale}/driver`);
  await page.getByTestId('field-code').or(page.getByTestId('field-day')).first().waitFor();
  if (await page.getByTestId('field-login').isVisible()) {
    await page.getByTestId('field-code').fill(code);
    await page.getByTestId('field-pin').fill(PIN);
    await page.getByTestId('field-signin').click();
  }
  await expect(page.getByTestId('field-day')).toBeVisible();
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  ownerId = owner.id;
  ownerSession = owner;
  const userId = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
     values ($1, $2, $3, true, 'driver', 'fr', 'active', false, now())`,
    [userId, `Chauffeur ${marker}`, `${marker}@field.kayas.invalid`],
  );
  const scene = await deliveryScene(app, owner.id, marker, today);
  const master = await orderMaster(app, owner.id, marker);
  const plant = await createPlant(app, owner, {
    code: `TQ${marker
      .slice(5, 9)
      .toUpperCase()
      .replace(/[^A-Z]/g, 'X')}`,
    name: `Centrale ${marker}`,
  });
  if (!plant.ok) throw new Error(plant.error);
  const plantId = plant.value.id;
  plantRowId = plantId;
  plantCode = plant.value.code;
  const phoneSet = await setPlantPhone(app, owner, plantId, '0539222222');
  if (!phoneSet.ok) throw new Error(phoneSet.error);
  await createUser(
    createAuth({ authPool: auth, env: { ...env, APP_BASE_URL: E2E_BASE_URL }, log: () => undefined }),
    auth,
    {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' as const },
      ...E2E_MD.sharedManager,
      password: E2E_PASSWORD,
      role: 'plant_manager',
      locale: 'fr',
      plantId,
    },
  );
  const driverId = await withRlsContext(
    app,
    { userId: owner.id, role: 'owner', requestId: marker },
    async (tx) => {
      await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
      const d = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, user_id) values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
        [code, `Chauffeur ${marker}`, owner.id, userId],
      );
      const id = d.rows[0]!.id;
      truckCode = (await tx.query<{ code: string }>('select code from truck where id = $1', [scene.truckId]))
        .rows[0]!.code;
      const o2 = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, today);
      const trip = async (orderId: string, load: number) =>
        (
          await tx.query<{ id: string }>(
            `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                                  unload_end_min, back_min, created_by)
             values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, $4, 4000, $5, $6, $7, $8, $9, $10) returning id`,
            [today, orderId, scene.truckId, id, load, load + 10, load + 40, load + 80, load + 110, owner.id],
          )
        ).rows[0]!.id;
      // decision 207: the plant manager reads only orders of his plant: this order is made in the plant (the shared scene's order has no plant)
      const o1 = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, today);
      orderAId = o1.id;
      tripA = await trip(o1.id, 420);
      tripB = await trip(o2.id, 480);
      const o3 = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, today);
      tripC = await trip(o3.id, 540);
      const o4 = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, today);
      tripD = await trip(o4.id, 600);
      orderD = (await tx.query<{ code: string }>('select code from sales_order where id = $1', [o4.id]))
        .rows[0]!.code;
      orderC = (await tx.query<{ code: string }>('select code from sales_order where id = $1', [o3.id]))
        .rows[0]!.code;
      orderA = (await tx.query<{ code: string }>('select code from sales_order where id = $1', [orderAId]))
        .rows[0]!.code;
      orderB = (await tx.query<{ code: string }>('select code from sales_order where id = $1', [o2.id]))
        .rows[0]!.code;
      return id;
    },
  );
  const ok = await setDriverPin(
    { appPool: app, authPool: auth, auth: {} as never, secret: env.AUTH_SECRET },
    owner,
    {
      driverId,
      pin: PIN,
    },
  );
  if (!ok.ok) throw new Error(ok.error);
});

const events = (trip: string) =>
  migrator.query<{
    step: string;
    source: string;
    implicit: boolean;
    actor_role: string | null;
    delivery_id: string | null;
    client_time: Date | null;
    at: Date;
  }>(
    `select step, source, implicit, actor_role, delivery_id, client_time, at from trip_event where trip_id = $1 order by created_at`,
    [trip],
  );

test('the plant records "loaded": the driver\'s screen shows it, done by the Centrale, and what comes next instead of a block', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  await expect(stage(driver, orderA, 'loaded')).toHaveAttribute('data-done', 'false');
  // the plant's number is a tel: link on the rotation of that plant (the owner set it)
  await expect(driver.getByTestId(`call-plant-${orderA}`)).toHaveAttribute('href', 'tel:0539222222');
  // the first tap is offered at once; there is no "waiting for the plant" block any more
  await expect(driver.getByTestId(`trip-wait-${orderA}`)).toHaveCount(0);

  const mgrCtx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const manager = await mgrCtx.newPage();
  await loginAndEnrol(manager, 'fr', E2E_MD.sharedManager.email);
  await manager.goto('/fr/trips');
  await expect(boardCard(manager, orderA, 420)).toBeVisible();
  await manager.getByTestId(`trip-next-${orderA}-420-${truckCode}`).click(); // the plant's own load: the BL
  await expect(manager.getByTestId(`trip-message-${orderA}`)).toContainText('Chargé');
  const rows = (await events(tripA)).rows;
  expect(rows.map((r) => [r.step, r.source, r.implicit])).toEqual([
    ['loading_started', 'plant', true],
    ['loaded', 'plant', false],
  ]);
  expect(rows[1]!.delivery_id).not.toBeNull();

  // the phone, with no reload: within the poll, loaded is done, by the Centrale, loading began is marked implicit
  await expect(stage(driver, orderA, 'loaded')).toHaveAttribute('data-done', 'true', { timeout: 40_000 });
  await expect(stage(driver, orderA, 'loaded')).toHaveAttribute('data-source', 'plant');
  await expect(stage(driver, orderA, 'loaded')).toContainText('Centrale');
  await expect(stage(driver, orderA, 'loading_started')).toHaveAttribute('data-implicit', 'true');
  await expect(driver.getByTestId(`tap-${orderA}`)).toContainText('Camion parti de la centrale');
  // the touch targets are at least 44 x 44
  for (const id of [`tap-${orderA}`, `tap-${orderB}`]) {
    const box = await driver.getByTestId(id).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await driver.screenshot({ path: `${SHOTS}/t9-driver-fr.png`, fullPage: true });
  await manager.screenshot({ path: `${SHOTS}/t9-plant-fr.png`, fullPage: true });
  await mgrCtx.storageState({ path: 'test-results/e2e-t9-manager.json' });
  await driverCtx.close();
  await mgrCtx.close();
});

test("the driver departs without declaring the load: the plant's board shows loaded (implicit) and departed, by the Chauffeur, within the poll", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const mgrCtx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    storageState: 'test-results/e2e-t9-manager.json',
  });
  const manager = await mgrCtx.newPage();
  await manager.goto('/fr/trips');
  await expect(boardCard(manager, orderB, 480)).toBeVisible();
  await expect(boardStep(manager, orderB, 480, 'departed')).toHaveAttribute('data-done', 'false');

  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  await driver.getByTestId(`tap-${orderB}`).click(); // loading started
  await expect(driver.getByTestId(`tap-${orderB}`)).toContainText('Chargé');
  const skipBox = await driver.getByTestId(`tap-skip-${orderB}`).boundingBox();
  expect(skipBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(skipBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  await driver.getByTestId(`tap-skip-${orderB}`).click(); // departed, without declaring the load
  await expect
    .poll(async () => (await events(tripB)).rows.map((r) => r.step), { timeout: 30_000 })
    .toEqual(['loading_started', 'loaded', 'departed']);
  const rows = (await events(tripB)).rows;
  expect(rows.map((r) => [r.step, r.source, r.implicit, r.actor_role])).toEqual([
    ['loading_started', 'driver', false, 'driver'],
    ['loaded', 'driver', true, 'driver'],
    ['departed', 'driver', false, 'driver'],
  ]);
  expect(rows[1]!.delivery_id).toBeNull(); // the driver's "loaded" is no load: nothing was made in the plant's books

  // the plant's board, no reload by the test: within the poll
  await expect(boardStep(manager, orderB, 480, 'departed')).toHaveAttribute('data-done', 'true', {
    timeout: 40_000,
  });
  await expect(boardStep(manager, orderB, 480, 'departed')).toHaveAttribute('data-source', 'driver');
  await expect(boardStep(manager, orderB, 480, 'departed')).toContainText('Chauffeur');
  await expect(boardStep(manager, orderB, 480, 'loaded')).toHaveAttribute('data-implicit', 'true');
  await expect(boardStep(manager, orderB, 480, 'loaded')).toContainText('déduit');
  // the driver's own screen marks the load as to be confirmed by the plant; it does not block him
  await expect(stage(driver, orderB, 'loaded')).toHaveAttribute('data-implicit', 'true');
  await expect(driver.getByTestId(`tap-${orderB}`)).toContainText('Arrivé');
  await driverCtx.close();
  await mgrCtx.close();
});

test('the driver declares "loaded"; the plant then makes its own load and it is attached to that stage (author and time kept)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  await driver.getByTestId(`tap-${orderC}`).click(); // loading started
  await driver.getByTestId(`tap-${orderC}`).click(); // loaded: declared, no load
  await expect
    .poll(async () => (await events(tripC)).rows.map((r) => r.step), { timeout: 30_000 })
    .toContain('loaded');
  const declared = (await events(tripC)).rows.find((r) => r.step === 'loaded')!;
  expect(declared.delivery_id).toBeNull();
  await expect(driver.getByTestId(`trip-hint-${orderC}`)).toContainText('La centrale confirmera');
  const deliveriesOf = async () =>
    Number(
      (
        await migrator.query<{ n: string }>(
          `select count(*) n from delivery where order_id = (select order_id from trip_plan where id = $1)`,
          [tripC],
        )
      ).rows[0]!.n,
    );
  expect(await deliveriesOf()).toBe(0);

  const mgrCtx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    storageState: 'test-results/e2e-t9-manager.json',
  });
  const manager = await mgrCtx.newPage();
  await manager.goto('/fr/trips');
  await expect(boardStep(manager, orderC, 540, 'loaded')).toContainText('déclaré par le chauffeur');
  await manager.getByTestId(`make-load-${orderC}`).click();
  await expect(manager.getByTestId(`trip-message-${orderC}`)).toContainText('Chargé');
  expect(await deliveriesOf()).toBe(1);
  const linked = (await events(tripC)).rows.find((r) => r.step === 'loaded')!;
  expect(linked.delivery_id).not.toBeNull();
  expect(linked.source).toBe('driver'); // whoever declared it stays the author
  expect(linked.at.getTime()).toBe(declared.at.getTime());
  await expect(manager.getByTestId(`make-load-${orderC}`)).toHaveCount(0);
  // the driver's hint goes away once the plant's load exists
  await expect(driver.getByTestId(`trip-hint-${orderC}`)).toHaveCount(0, { timeout: 40_000 });
  await driverCtx.close();
  await mgrCtx.close();
});

test('the plant manager corrects a time with a reason: a new row, the audit log, the stage untouched, shown corrected on both screens', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const mgrCtx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    storageState: 'test-results/e2e-t9-manager.json',
  });
  const manager = await mgrCtx.newPage();
  await manager.goto('/fr/trips');
  const before = (await events(tripB)).rows.find((r) => r.step === 'departed')!;
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  // the driver has no way to correct
  await expect(driver.getByTestId(`correct-${orderB}-departed`)).toHaveCount(0);

  const open = manager.getByTestId(`correct-${orderB}-departed`);
  const box = await open.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await open.click();
  const when = clockOf(new Date(Date.now() + 2 * 60_000).toISOString());
  await manager.getByTestId(`correct-time-${orderB}`).fill(when);
  await manager.getByTestId(`correct-reason-${orderB}`).fill('Heure relue au portail');
  await manager.getByTestId(`correct-save-${orderB}`).click();
  await expect(manager.getByTestId(`trip-message-${orderB}`)).toContainText('Heure corrigée');
  await expect(boardStep(manager, orderB, 480, 'departed')).toContainText('corrigé');
  await expect(boardStep(manager, orderB, 480, 'departed')).toContainText(when);

  const corr = await migrator.query<{ reason: string; actor_role: string; previous_at: Date }>(
    `select reason, actor_role, previous_at from trip_event_correction where trip_id = $1`,
    [tripB],
  );
  expect(corr.rows).toHaveLength(1);
  expect(corr.rows[0]).toMatchObject({ reason: 'Heure relue au portail', actor_role: 'plant_manager' });
  expect(corr.rows[0]!.previous_at.getTime()).toBe(before.at.getTime());
  const after = (await events(tripB)).rows.find((r) => r.step === 'departed')!;
  expect(after.at.getTime()).toBe(before.at.getTime()); // the stage itself is untouched
  const audit = await migrator.query<{ actor_user_id: string; reason: string }>(
    `select actor_user_id, reason from audit_event where action = 'reverse' and table_name = 'trip_event' and reason = 'Heure relue au portail'`,
  );
  expect(audit.rows).toHaveLength(1);
  // and the driver's screen shows it, corrected, within the poll
  await expect(stage(driver, orderB, 'departed')).toContainText('corrigé', { timeout: 40_000 });
  await driverCtx.close();
  await mgrCtx.close();
});

test("a driver's taps through the unloading change no stock and deliver nothing; the plant confirms the delivery once", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const count = async () => {
    const q = async (sql: string) => Number((await migrator.query<{ n: string }>(sql, [tripA])).rows[0]!.n);
    return {
      deliveries: await q(
        `select count(*) n from delivery where order_id = (select order_id from trip_plan where id = $1)`,
      ),
      stock: await q(
        `select count(*) n from stock_movement where source = 'delivery' and source_id in (select id from delivery where order_id = (select order_id from trip_plan where id = $1))`,
      ),
      delivered: await q(
        `select count(*) n from delivery_delivered where delivery_id in (select id from delivery where order_id = (select order_id from trip_plan where id = $1))`,
      ),
      invoiced: await q(
        `select count(*) n from invoice_line where delivery_id in (select id from delivery where order_id = (select order_id from trip_plan where id = $1))`,
      ),
    };
  };
  const before = await count();
  expect(before).toMatchObject({ deliveries: 1, delivered: 0 });
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  for (const s of ['departed', 'arrived', 'unloading_started']) {
    await driver.getByTestId(`tap-${orderA}`).click();
    await expect
      .poll(async () => (await events(tripA)).rows.map((r) => r.step), { timeout: 30_000 })
      .toContain(s);
  }
  await driver.getByTestId(`tap-${orderA}`).click(); // unloading finished: asks the m3
  await driver.getByTestId('field-m3').fill('4');
  await driver.getByTestId('field-m3-ok').click();
  await expect
    .poll(async () => (await events(tripA)).rows.map((r) => r.step), { timeout: 30_000 })
    .toContain('unloading_finished');
  expect(await count()).toEqual(before); // no delivery, no stock movement, nothing delivered, nothing invoiced

  const mgrCtx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    storageState: 'test-results/e2e-t9-manager.json',
  });
  const manager = await mgrCtx.newPage();
  await manager.goto('/fr/trips');
  const confirm = manager.getByTestId(`confirm-delivered-${orderA}`);
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(manager.getByTestId(`trip-message-${orderA}`)).toContainText('Livraison confirmée');
  const after = await count();
  expect(after).toEqual({ ...before, delivered: 1 });
  await expect(manager.getByTestId(`confirm-delivered-${orderA}`)).toHaveCount(0);
  await driverCtx.close();
  await mgrCtx.close();
});

test("offline: the tap is queued and marked pending, then replayed once with the phone's time; the server keeps its own", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  await expect(driver.getByTestId(`tap-${orderA}`)).toContainText('De retour');
  await driverCtx.setOffline(true);
  const tappedAt = Date.now();
  await driver.getByTestId(`tap-${orderA}`).click(); // back, offline
  await expect(driver.getByTestId('field-queued')).toBeVisible();
  await expect(stage(driver, orderA, 'back')).toContainText("en attente d'envoi");
  expect((await events(tripA)).rows.map((r) => r.step)).not.toContain('back');
  await driverCtx.setOffline(false);
  await expect
    .poll(async () => (await events(tripA)).rows.map((r) => r.step), { timeout: 60_000 })
    .toContain('back');
  await expect(driver.getByTestId('field-queued')).toHaveCount(0, { timeout: 60_000 });
  const back = (await events(tripA)).rows.filter((r) => r.step === 'back');
  expect(back).toHaveLength(1);
  expect(back[0]!.source).toBe('driver');
  expect(back[0]!.client_time).not.toBeNull();
  expect(Math.abs(back[0]!.client_time!.getTime() - tappedAt)).toBeLessThan(30_000); // the phone's own time of the tap
  expect(back[0]!.at.getTime()).toBeGreaterThanOrEqual(back[0]!.client_time!.getTime()); // the server's instant is the later one
  await expect(stage(driver, orderA, 'back')).not.toContainText("en attente d'envoi");
  await driverCtx.close();
});

test('T9b: a driver-declared delivery is flagged and never billable; the plant confirms departure and return; the return sets the billing gate once', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const gate = async () =>
    Number(
      (
        await migrator.query<{ n: string }>(
          `select count(*) n from delivery_delivered where delivery_id in (select d.id from delivery d join trip_plan p on p.order_id = d.order_id where p.id = $1)`,
          [tripD],
        )
      ).rows[0]!.n,
    );
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  // the office number, when the company profile has one, is a tel: link; when it has none there is no link
  const call = driver.getByTestId('call-office');
  if (await call.count()) expect(await call.getAttribute('href')).toMatch(/^tel:/);
  for (const _ of ['loading_started', 'loaded', 'departed', 'arrived', 'unloading_started']) {
    await driver.getByTestId(`tap-${orderD}`).click();
  }
  await driver.getByTestId(`tap-${orderD}`).click(); // unloading finished: asks the m3
  await driver.getByTestId('field-m3').fill('1');
  await driver.getByTestId('field-m3-ok').click();
  await driver.getByTestId(`tap-${orderD}`).click(); // back
  await expect
    .poll(async () => (await events(tripD)).rows.map((r) => r.step), { timeout: 40_000 })
    .toContain('back');
  // the driver's own screen: departed and back wait for the plant; the delivery is his declaration
  await expect(stage(driver, orderD, 'departed')).toContainText('en attente de la centrale');
  await expect(stage(driver, orderD, 'unloading_finished')).toContainText('déclarée par le chauffeur');
  expect(await gate()).toBe(0);

  const mgrCtx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    storageState: 'test-results/e2e-t9-manager.json',
  });
  const manager = await mgrCtx.newPage();
  await manager.goto('/fr/trips');
  await expect(boardStep(manager, orderD, 600, 'unloading_finished')).toContainText(
    'livraison déclarée par le chauffeur',
  );
  await expect(boardStep(manager, orderD, 600, 'departed')).toContainText('en attente de la centrale');
  // flagged, with a clear label, and not billable: the plant has no load of it
  await expect(manager.getByTestId(`exception-declared_no_record-${orderD}`)).toBeVisible();
  await expect(manager.getByTestId(`exception-declared_no_record-${orderD}`)).toContainText(
    'Déclarée par le chauffeur',
  );
  // the plant confirms the departure: its time becomes the one in use
  await manager.getByTestId(`confirm-stage-${orderD}-departed`).click();
  await expect(manager.getByTestId(`trip-message-${orderD}`)).toContainText('Étape confirmée');
  await expect(boardStep(manager, orderD, 600, 'departed')).not.toContainText('en attente de la centrale');
  // the plant makes its own load, then confirms the return: the gate is set once, by the plant user, in that step
  await manager.getByTestId(`make-load-${orderD}`).click();
  await expect(manager.getByTestId(`trip-message-${orderD}`)).toContainText('Chargé');
  expect(await gate()).toBe(0);
  await manager.getByTestId(`confirm-stage-${orderD}-back`).click();
  await expect(manager.getByTestId(`trip-message-${orderD}`)).toContainText('Étape confirmée');
  expect(await gate()).toBe(1);
  const via = await migrator.query<{ via: string }>(
    `select via from delivery_delivered where delivery_id in (select d.id from delivery d join trip_plan p on p.order_id = d.order_id where p.id = $1)`,
    [tripD],
  );
  expect(via.rows[0]!.via).toBe('return');
  await manager.reload();
  await expect(manager.getByTestId(`exception-declared_no_record-${orderD}`)).toHaveCount(0);
  // Arabic: the same status in the labels of the language
  await manager.goto('/ar/trips');
  await expect(boardStep(manager, orderD, 600, 'unloading_finished')).toContainText('تسليم صرّح به السائق');
  await driverCtx.close();
  await mgrCtx.close();
});

test('T9b addendum: the owner sets the plant number (audited), the plant manager cannot; the driver sees a tel: link for it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await loginOwner(owner, 'fr');
  await owner.goto('/fr/master-data/plants');
  await owner.getByTestId(`plant-phone-${plantCode}`).fill('+212 5 39 33 33 33');
  await owner.getByTestId(`plant-phone-save-${plantCode}`).click();
  await expect(owner.getByTestId('plant-message')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await migrator.query<{ phone: string }>('select phone from plant where id = $1', [plantRowId]))
          .rows[0]!.phone,
    )
    .toBe('+212 5 39 33 33 33');
  const audit = await migrator.query(
    `select 1 from audit_event where table_name = 'plant' and action = 'update' and row_id = $1 and after->>'phone' = '+212 5 39 33 33 33'`,
    [plantRowId],
  );
  expect(audit.rowCount).toBeGreaterThan(0);
  await ownerCtx.close();

  const mgrCtx = await browser.newContext({ storageState: 'test-results/e2e-t9-manager.json' });
  const manager = await mgrCtx.newPage();
  await manager.goto('/fr/master-data/plants');
  await expect(manager.getByTestId(`plant-phone-${plantCode}`)).toHaveCount(0); // nobody but the owner and app_admin edits or reads it here
  await mgrCtx.close();

  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver);
  await expect(driver.getByTestId(`call-plant-${orderA}`)).toHaveAttribute('href', 'tel:+212 5 39 33 33 33');
  await driverCtx.close();
});

test('Arabic: both screens read right-to-left with the same status; screenshots', async ({ browser }) => {
  test.setTimeout(240_000);
  const driverCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const driver = await driverCtx.newPage();
  await phone(driver, 'ar');
  await expect(driver.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(stage(driver, orderB, 'departed')).toContainText('السائق');
  await expect(stage(driver, orderB, 'loaded')).toContainText('مستنتج');
  expect(await driver.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await driver.screenshot({ path: `${SHOTS}/t9-driver-ar.png`, fullPage: true });
  const mgrCtx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    storageState: 'test-results/e2e-t9-manager.json',
  });
  const manager = await mgrCtx.newPage();
  await manager.goto('/ar/trips');
  await expect(manager.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(boardStep(manager, orderB, 480, 'departed')).toContainText('السائق');
  expect(await manager.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await manager.screenshot({ path: `${SHOTS}/t9-plant-ar.png`, fullPage: true });
  await driverCtx.close();
  await mgrCtx.close();
  expect(ownerId).toBeTruthy();
});
