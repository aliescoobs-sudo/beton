import { expect, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { businessDateOf, realClock } from '../src/modules/clock';
import { setDriverPin } from '../src/modules/field';
import { createPlant, createTruck } from '../src/modules/master-data';
import { minuteOfDay } from '../src/modules/operations/domain/trip-times';
import { testEnv } from '../tests/db-env';
import { realSessionUser } from '../tests/helpers/actors';
import { deliveryScene, insertDelivery, insertOrder, orderMaster } from '../tests/helpers/ledger-fixtures';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { E2E_BASE_URL, E2E_MD, E2E_PASSWORD, loginAndEnrol } from './fixtures';

// T5 phase 2, end to end: a driver taps a stage late -> the plant board shows a critical alert naming the next order -> the plant manager
// reassigns that order to another truck with a reason -> the driver's list no longer holds it and his alert is gone.
test.describe.configure({ mode: 'serial' });

const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
test.afterAll(() => Promise.all([migrator.end(), app.end(), auth.end()]));

const marker = `e2etm${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const today = businessDateOf(realClock.now());
const nowMin = minuteOfDay(realClock.now().toISOString());
const code = `CH-${4000 + Math.floor(Math.random() * 900)}`;
const PIN = '482913';
const DEVICE = 'e2e-timing-phone-0123456789abcdef012345';
let order1 = '';
let order2 = '';
let truckCode = '';
let spareCode = '';
let plantId = '';
let sparePlant = '';

test.beforeAll(async () => {
  test.skip(nowMin < 60 || nowMin > 1300, 'needs a plan around the current hour that fits inside the day');
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  const userId = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
     values ($1, $2, $3, true, 'driver', 'fr', 'active', false, now())`,
    [userId, `Chauffeur ${marker}`, `${marker}@field.kayas.invalid`],
  );
  // the scene first (one plant at most while it is made), then the plant of the spec
  const scene = await deliveryScene(app, owner.id, marker, today);
  const master = await orderMaster(app, owner.id, marker);
  const plant = await createPlant(app, owner, {
    code: `TM${marker
      .slice(5, 9)
      .toUpperCase()
      .replace(/[^A-Z]/g, 'X')}`,
    name: `Centrale ${marker}`,
  });
  if (!plant.ok) throw new Error(plant.error);
  plantId = plant.value.id;
  sparePlant = plantId;
  const spare = await createTruck(app, owner, {
    code: `T${200 + Math.floor(Math.random() * 700)}`,
    plate: `TM-${marker.slice(5)}`,
    plantId,
  });
  if (!spare.ok) throw new Error(spare.error);
  spareCode = spare.value.code;
  // the plant manager of that plant (a plant manager is created bound to its plant)
  await createUser(
    createAuth({ authPool: auth, env: { ...env, APP_BASE_URL: E2E_BASE_URL }, log: () => undefined }),
    auth,
    {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' as const },
      ...E2E_MD.timingManager,
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
      // rotation 1 should have departed 40 minutes ago; rotation 2 of the same truck is planned to load in 30 minutes
      // decision 207 / R18-01: a plant manager sees a rotation only when its order is of his plant (the shared scene's order has no plant): both orders are made in the plant
      const o1 = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, today);
      const o2 = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, today);
      const trip = async (orderId: string, base: number) =>
        (
          await tx.query<{ id: string }>(
            `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                                  unload_end_min, back_min, created_by)
           values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, $4, 8000, $5, $6, $7, $8, $9, $10) returning id`,
            [today, orderId, scene.truckId, id, base, base + 10, base + 40, base + 80, base + 110, owner.id],
          )
        ).rows[0]!.id;
      const t1 = await trip(o1.id, nowMin - 50); // planned departure = nowMin - 40
      await trip(o2.id, nowMin + 30);
      const dl = await insertDelivery(tx, owner.id, { ...scene, orderId: o1.id }, 8000);
      const delivery = (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [dl.blNo]))
        .rows[0]!.id;
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now() - interval '1 minute', $2, $3)`,
        [t1, delivery, owner.id],
      );
      order1 = (await tx.query<{ code: string }>('select code from sales_order where id = $1', [o1.id]))
        .rows[0]!.code;
      order2 = (await tx.query<{ code: string }>('select code from sales_order where id = $1', [o2.id]))
        .rows[0]!.code;
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

async function driverDay(page: Page) {
  await page.addInitScript((id) => {
    if (!localStorage.getItem('bb_field_device')) localStorage.setItem('bb_field_device', id);
  }, DEVICE);
  await page.goto('/fr/driver');
  await page.getByTestId('field-code').or(page.getByTestId('field-day')).first().waitFor();
  if (await page.getByTestId('field-login').isVisible()) {
    await page.getByTestId('field-code').fill(code);
    await page.getByTestId('field-pin').fill(PIN);
    await page.getByTestId('field-signin').click();
  }
  await expect(page.getByTestId('field-day')).toBeVisible();
}

test('a late departure makes the next rotation critical on the board; the plant manager reassigns it; the driver sees the change', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  // 1. the driver taps loading and departure about 40 minutes after the plan
  await driverDay(page);
  await expect(page.getByTestId(`trip-${order1}`)).toBeVisible();
  await expect(page.getByTestId(`trip-${order2}`)).toBeVisible();
  await expect(page.getByTestId(`timing-${order1}`)).toContainText('Prévu');
  await page.getByTestId(`tap-${order1}`).click(); // loading started
  await page
    .getByTestId(`reason-${order1}`)
    .selectOption('traffic')
    .catch(() => undefined);
  await page.getByTestId(`tap-${order1}`).click(); // departed
  await expect
    .poll(
      async () =>
        (
          await migrator.query(
            `select 1 from trip_event e join trip_plan p on p.id = e.trip_id where e.step = 'departed' and p.driver_id = (select id from driver where code = $1)`,
            [code],
          )
        ).rowCount,
      { timeout: 30_000 },
    )
    .toBe(1);
  // the driver's own list shows the delay and the banner naming the next order (no price anywhere)
  await expect(page.getByTestId(`alert-critical-${order1}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`alert-critical-${order1}`)).toContainText(order2);
  await expect(page.getByTestId(`delay-${order1}`)).toContainText('+');
  const delay = await migrator.query<{ cumulative_delay_min: number; reason: string | null }>(
    `select d.cumulative_delay_min, d.reason from trip_delay d join trip_plan p on p.id = d.trip_id where d.step = 'departed' and p.driver_id = (select id from driver where code = $1)`,
    [code],
  );
  expect(delay.rows[0]!.cumulative_delay_min).toBeGreaterThanOrEqual(35);

  // 2. the plant manager of that plant sees it on the board and reassigns the next order to the spare truck
  const ctx = await browser.newContext();
  const manager = await ctx.newPage();
  await loginAndEnrol(manager, 'fr', E2E_MD.timingManager.email);
  await manager.goto('/fr/dispatch');
  const truck = manager.getByTestId(`timing-truck-${truckCode}`);
  await expect(truck).toBeVisible();
  await expect(manager.getByTestId(`timing-level-${truckCode}`)).toHaveText('Retard prévu');
  await expect(manager.getByTestId(`timing-alert-${truckCode}`)).toContainText(order2);
  await manager.getByTestId(`reassign-${order2}`).click();
  await manager.getByTestId(`act-truck-${order2}`).selectOption({ label: spareCode });
  await manager.getByTestId(`act-reason-${order2}`).fill('Le camion revient trop tard');
  await manager.getByTestId(`act-confirm-${order2}`).click();
  await expect(manager.getByTestId('timing-message')).toBeVisible();
  const logged = await migrator.query(
    `select kind, reason from trip_dispatch_change where reason = 'Le camion revient trop tard'`,
  );
  expect(logged.rows[0]).toMatchObject({ kind: 'reassign' });
  await ctx.close();

  // 3. the driver's list: the order moved to another truck (with no driver yet) is gone, and so is his alert
  await page.reload();
  await expect(page.getByTestId('field-day')).toBeVisible();
  await expect(page.getByTestId(`trip-${order2}`)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId(`alert-critical-${order1}`)).toHaveCount(0);
});
