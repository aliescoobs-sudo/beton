import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { listTrips } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  type DeliveryScene,
} from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';
import { freeDriverCode } from './helpers/codes';

// Privacy residual of group B (migration 0122): who reads the raw taps of a named driver. trip_event: partner and support KEEP the read (the
// dispatch board needs it) but a plant manager only reads his own plant's. trip_driver_report: nothing in the application reads it with the app
// login, so only the owner and the plant manager of the plant read it directly.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `tx${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const date = '2092-05-04';

let done: () => Promise<void>;
let owner: SessionUser, pmA: SessionUser, pmB: SessionUser, partner: SessionUser, support: SessionUser;
let office: SessionUser, accountant: SessionUser;
let plantA = '',
  plantB = '',
  trip = '';
let scene: DeliveryScene;

const as = <T>(u: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);
const count = (u: SessionUser, table: string) =>
  as(u, async (tx) =>
    Number(
      (await tx.query<{ n: string }>(`select count(*)::text n from ${table} where trip_id = $1`, [trip]))
        .rows[0]!.n,
    ),
  );

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantA = v.plantId;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  partner = v.session('partner') as unknown as SessionUser;
  support = v.session('support') as unknown as SessionUser;
  office = v.session('office_sales') as unknown as SessionUser;
  accountant = v.session('accountant') as unknown as SessionUser;
  const master = await orderMaster(app, owner.id, `${marker}a`);
  scene = await deliveryScene(app, owner.id, `${marker}a`, '2092-01-01');
  const b = await createPlant(app, owner, {
    code: Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(''), // 26^6, not 7^4 (a code made of the marker's hex letters met itself now and then)
    name: `TX B ${marker}`,
  });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, 'plant_manager', 'fr', 'active', true, now(), $4)`,
    [id, `${marker} pmB`, `${marker}-pmb-${id}@kayas.test`, plantB],
  );
  pmB = {
    id,
    name: `${marker} pmB`,
    email: `${id}@kayas.test`,
    role: 'plant_manager',
    locale: 'fr',
    twoFactorEnabled: true,
    reenrolRequired: false,
  } as unknown as SessionUser;
  // a rotation of plant A, one event and one driver report, written the way the definer functions write them
  const order = await withRlsContext(
    app,
    { userId: owner.id, role: 'owner', requestId: marker },
    async (tx) => {
      await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
      return insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, date);
    },
  );
  trip = randomUUID();
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, 4000, 420, 430, 460, 500, 530, $6)`,
      [trip, randomUUID(), date, order.id, scene.truckId, owner.id],
    );
  });
  const d = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
    const del = await insertDelivery(
      tx,
      owner.id,
      { orderId: order.id, truckId: scene.truckId, recetteId: scene.recetteId },
      1000,
    );
    return (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [del.blNo])).rows[0]!
      .id;
  });
  const driverId = randomUUID();
  const driverCode = await freeDriverCode();
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query(`insert into driver (id, code, name, created_by, kind) values ($1, $2, $3, $4, 'driver')`, [
      driverId,
      driverCode,
      `Chauffeur ${marker}`,
      owner.id,
    ]),
  );
  await withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(
      `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now(), $2, $3)`,
      [trip, d, owner.id],
    );
    await tx.query(
      `insert into trip_driver_report (id, trip_id, driver_id, kind, at, client_key) values (gen_random_uuid(), $1, $2, 'loading_started', now(), $3)`,
      [trip, driverId, `${marker}:report`],
    );
  });
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('the rotation of the fixture belongs to plant A', () => {
  it('has a plant, the one of its order', async () => {
    const r = await migrator.query<{ plant_id: string | null }>(
      'select plant_id from trip_plan where id = $1',
      [trip],
    );
    expect(r.rows[0]?.plant_id).toBe(plantA);
  });
});

describe('trip_event: owner and the plant manager of the plant only (T8: partner and support lost the read, 0208)', () => {
  it.each([
    ['owner', () => owner, 1],
    ['partner', () => partner, 0],
    ['support', () => support, 0],
    ['the plant manager of the plant', () => pmA, 1],
    ['the plant manager of ANOTHER plant', () => pmB, 0],
    ['office_sales', () => office, 0],
    ['accountant', () => accountant, 0],
  ])('%s sees %i event(s)', async (_who, who, n) => {
    expect(await count(who(), 'trip_event')).toBe(n);
  });
  it('the board shows the steps to the plant manager of the plant, and is refused outright to the partner and to support', async () => {
    const r = await listTrips(app, pmA, date);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.some((t) => t.id === trip && t.events.loaded !== undefined)).toBe(true);
    for (const u of [partner, support]) await expect(listTrips(app, u, date), u.role).rejects.toThrow();
  });
  it('the plant manager of another plant sees no step of that rotation on his board', async () => {
    const r = await listTrips(app, pmB, date);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.find((t) => t.id === trip)?.events.loaded).toBeUndefined();
  });
});

describe('trip_driver_report: no feature reads it with the app login, so partner, office and support no longer do', () => {
  it.each([
    ['owner', () => owner, 1],
    ['the plant manager of the plant', () => pmA, 1],
    ['the plant manager of ANOTHER plant', () => pmB, 0],
    ['partner', () => partner, 0],
    ['support', () => support, 0],
    ['office_sales', () => office, 0],
    ['accountant', () => accountant, 0],
  ])('%s sees %i report(s)', async (_who, who, n) => {
    expect(await count(who(), 'trip_driver_report')).toBe(n);
  });
});
