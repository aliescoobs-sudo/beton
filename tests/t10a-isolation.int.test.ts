import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { getDispatchDay, listDrivers, listTrips } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import { deliveryScene, insertOrder, orderMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';
import { freeTruckCode } from './helpers/codes';

/**
 * T10a, R17-02 and decision 207. Plants A and B, and a rotation with NO plant. Everything is tried as the application login (raw SQL), then
 * through the services, then in the serialized properties the screens receive.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `ti${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const date = '2093-03-09';

let done: () => Promise<void>;
let owner: SessionUser, appAdmin: SessionUser, pmA: SessionUser, pmB: SessionUser;
let plantA = '',
  plantB = '';
interface Rot {
  trip: string;
  order: string;
  orderCode: string;
  driver: string;
  driverName: string;
  reason: string;
  truck: string;
}
let A: Rot, B: Rot, N: Rot;
let freeDriver = '';
let raceN = 0;

async function superSql(sql: string, params: unknown[] = []): Promise<number> {
  const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
  await c.connect();
  try {
    await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
      SYSTEM_ACTOR_ID,
    ]);
    return (await c.query(sql, params)).rowCount ?? 0;
  } finally {
    await c.end();
  }
}
const as = <T>(u: { id: string; role: string }, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);
const asMigrator = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, fn);
/** The error a statement raises (code and message), or null. Each call is its own rolled-back transaction. */
async function failure(u: { id: string; role: string }, sql: string, args: unknown[] = []) {
  try {
    await as(u, async (tx) => {
      await tx.query(sql, args);
      throw new Error('__ran__');
    });
  } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.message === '__ran__') return null;
    return { code: err.code, message: err.message };
  }
  return null;
}

/** A driver with a free code (CH-nnnn; other files take codes at random, so a taken one is retried). */
async function newDriver(tx: pg.PoolClient, id: string, name: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await tx.query('savepoint nd');
    try {
      await tx.query(
        `insert into driver (id, code, name, created_by) values ($1, 'CH-' || (1000 + floor(random() * 8999))::int, $2, $3)`,
        [id, name, owner.id],
      );
      await tx.query('release savepoint nd');
      return;
    } catch (e) {
      await tx.query('rollback to savepoint nd');
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  throw new Error('no free driver code');
}
async function makeRot(
  plant: string | null,
  label: string,
  truckBase: string,
  driverName: string,
): Promise<Rot> {
  const master = await orderMaster(app, owner.id, `${marker}${label}`);
  const scene = await deliveryScene(app, owner.id, `${marker}${label}`, '2093-01-01');
  const driver = randomUUID();
  const reason = `reason-${label}-${marker}`;
  const trip = randomUUID();
  const truck = scene.truckId;
  const order = await as(owner, async (tx) => {
    if (plant) await tx.query(`select set_config('app.plant_id', $1, true)`, [plant]);
    const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, date);
    await newDriver(tx, driver, driverName);
    // the truck has another default driver, so the rotation's driver is an override that carries a reason
    const dflt = randomUUID();
    await newDriver(tx, dflt, `Default ${label} ${marker}`);
    await tx.query(`update truck set default_driver_id = $2 where id = $1`, [truck, dflt]);
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, driver_override_reason, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, $6, $7, 4000, 420, 430, 460, 500, 530, $8)`,
      [trip, randomUUID(), date, o.id, truck, driver, reason, owner.id],
    );
    return o;
  });
  void truckBase;
  return { trip, order: order.id, orderCode: order.code, driver, driverName, reason, truck };
}

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantA = v.plantId;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  appAdmin = v.session('app_admin') as unknown as SessionUser;
  // the delivery scenes are made while there is one plant only (a second one makes the plant mandatory on an order)
  for (const l of ['a', 'b', 'n', 'r1', 'r2'])
    await deliveryScene(app, owner.id, `${marker}${l}`, '2093-01-01');
  const b = await createPlant(app, owner, {
    code: `T${marker.slice(2, 7).toUpperCase().replace(/[0-9]/g, 'Y')}`,
    name: `TI B ${marker}`,
  });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  const idB = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, 'plant_manager', 'fr', 'active', true, now(), $4)`,
    [idB, `${marker} pmB`, `${marker}-pmb-${idB}@kayas.test`, plantB],
  );
  pmB = { id: idB, name: `${marker} pmB`, role: 'plant_manager', locale: 'fr' } as unknown as SessionUser;
  A = await makeRot(plantA, 'a', 'A', `Driver A ${marker}`);
  B = await makeRot(plantB, 'b', 'B', `Driver B ${marker}`);
  N = await makeRot(plantA, 'n', 'N', `Driver N ${marker}`);
  // a legacy rotation: made before plants existed, so it and its order name no plant (made by hand: the plan is append-only)
  for (const t of ['trip_plan', 'sales_order']) await superSql(`alter table ${t} disable trigger user`);
  try {
    await superSql(`update trip_plan set plant_id = null where id = $1`, [N.trip]);
    await superSql(`update sales_order set plant_id = null where id = $1`, [N.order]);
  } finally {
    for (const t of ['sales_order', 'trip_plan']) await superSql(`alter table ${t} enable trigger user`);
  }
  freeDriver = randomUUID();
  await as(owner, (tx) => newDriver(tx, freeDriver, `Free ${marker}`));
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

const ids = () => [A.trip, B.trip, N.trip];

describe('R17-02: a plant manager reads his plant only; a rotation with no plant is not his (decision 207)', () => {
  it('raw SELECT of the plan, the orders, the drivers and the override reasons', async () => {
    const plans = await as(pmA, (tx) =>
      tx.query<{ id: string; driver_override_reason: string }>(
        `select id, driver_override_reason from trip_plan where id = any($1)`,
        [ids()],
      ),
    );
    expect(plans.rows.map((r) => r.id)).toEqual([A.trip]);
    // (the money table itself is closed to a plant manager; his path to an order is the operational view below)
    const orders = await as(pmA, (tx) =>
      tx.query(`select id from sales_order where id = any($1)`, [[A.order, B.order, N.order]]),
    );
    expect(orders.rowCount).toBe(0);
    const drivers = await as(pmA, (tx) =>
      tx.query<{ id: string }>(`select id from driver where id = any($1)`, [
        [A.driver, B.driver, N.driver, freeDriver],
      ]),
    );
    expect(drivers.rows.map((r) => r.id)).toEqual([A.driver]);
    // the view the screens use
    const ops = await as(pmA, (tx) =>
      tx.query(`select id from sales_order_ops where id = any($1)`, [[A.order, B.order, N.order]]),
    );
    expect(ops.rows.map((r: { id: string }) => r.id)).toEqual([A.order]);
  });

  it('owner and app_admin keep the all-plants path (A, B and the rotation with no plant, and every driver)', async () => {
    for (const u of [owner, appAdmin]) {
      const plans = await as(u, (tx) => tx.query(`select id from trip_plan where id = any($1)`, [ids()]));
      expect(plans.rowCount).toBe(3);
      const drivers = await as(u, (tx) =>
        tx.query(`select id from driver where id = any($1)`, [[A.driver, B.driver, N.driver, freeDriver]]),
      );
      expect(drivers.rowCount).toBe(4);
    }
  });

  it('a driver is visible to a plant manager through a truck default of his plant, or a rotation at his plant', async () => {
    // the free driver becomes the default driver of a truck of plant A (a truck of its own: the shared trucks keep their plant)
    const truck = randomUUID();
    expect(
      await superSql(`insert into truck (id, code, plate, plant_id) values ($1, $4, $2, $3)`, [
        truck,
        `TI-${marker}`,
        plantA,
        await freeTruckCode('T'),
      ]),
    ).toBe(1);
    expect(await superSql(`update truck set default_driver_id = $2 where id = $1`, [truck, freeDriver])).toBe(
      1,
    );
    const seen = await as(pmA, (tx) => tx.query(`select id from driver where id = $1`, [freeDriver]));
    expect(seen.rowCount).toBe(1);
    const notB = await as(pmB, (tx) => tx.query(`select id from driver where id = $1`, [freeDriver]));
    expect(notB.rowCount).toBe(0);
    await superSql(`update truck set default_driver_id = null where id = $1`, [truck]);
  });

  it('a plant manager cannot plan a driver who is not his plant (the affiliation rule is in the policy)', async () => {
    await superSql(`update truck set default_driver_id = null where id = $1`, [A.truck]); // no default: no reason needed, only the policy speaks
    const e = await failure(
      pmA,
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, driver_override_reason, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
       values (gen_random_uuid(), gen_random_uuid(), $1, $2, 2, $3, $4, null, 1000, 600, 610, 640, 680, 710, $5)`,
      [date, A.order, A.truck, B.driver, pmA.id],
    );
    expect(e?.code).toBe('42501');
    // R18-01: the references are checked first, with one answer that names none (before it was the policy's text)
    expect(e?.message).toMatch(/reference not available/);
  });

  it('the services and the serialized props: the day screen, the trips list and the roster carry nothing of B or of the plant-less rotation', async () => {
    const day = await getDispatchDay(app, pmA, date, { plantId: plantA });
    if (!day.ok) throw new Error('day');
    const wire = JSON.stringify(day.value);
    for (const needle of [
      B.trip,
      N.trip,
      B.order,
      N.order,
      B.orderCode,
      N.orderCode,
      B.driver,
      N.driver,
      B.driverName,
      N.driverName,
      B.reason,
      N.reason,
      freeDriver,
      plantB,
    ])
      expect(wire).not.toContain(needle);
    expect(wire).toContain(A.trip);
    expect(wire).toContain(A.driverName);
    const trips = await listTrips(app, pmA, date);
    if (!trips.ok) throw new Error('trips');
    const wire2 = JSON.stringify(trips.value);
    for (const needle of [B.trip, N.trip, B.driverName, N.driverName, B.reason, N.reason])
      expect(wire2).not.toContain(needle);
    const roster = JSON.stringify(await listDrivers(app, pmA));
    for (const needle of [B.driver, N.driver, B.driverName, N.driverName, freeDriver])
      expect(roster).not.toContain(needle);
    expect(roster).toContain(A.driver);
    // the owner's roster and day carry everything
    const ownerWire = JSON.stringify(await getDispatchDay(app, owner, date, {}));
    for (const needle of [A.trip, B.trip, N.trip, A.driver, B.driver, N.driver, freeDriver])
      expect(ownerWire).toContain(needle);
  });

  it('the office board (dispatch_office) shows a plant manager his plant only', async () => {
    const r = await as(pmA, (tx) =>
      tx.query<{ trip_id: string }>(`select trip_id from public.dispatch_office($1)`, [date]),
    );
    const got = r.rows.map((x) => x.trip_id);
    expect(got).toContain(A.trip);
    expect(got).not.toContain(B.trip);
    expect(got).not.toContain(N.trip);
  });
});

describe('R17-02: cancellations and steps of a rotation are written and read through its plant, with one answer for "forbidden" and "absent"', () => {
  const cancel = (u: { id: string; role: string }, trip: string) =>
    failure(
      u,
      `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'replanned', $2)`,
      [trip, u.id],
    );

  it('manager A cannot cancel B or a plant-less rotation, nor an id that does not exist, and the three answers are identical', async () => {
    const fb = await cancel(pmA, B.trip);
    const fn = await cancel(pmA, N.trip);
    const fx = await cancel(pmA, randomUUID());
    expect(fb).not.toBeNull();
    expect(fb).toEqual(fx);
    expect(fn).toEqual(fx);
    const rows = await migrator.query(`select 1 from trip_plan_cancellation where trip_id = any($1)`, [
      [B.trip, N.trip],
    ]);
    expect(rows.rowCount).toBe(0); // unchanged
  });

  it('no start oracle: a STARTED rotation of B answers exactly like an unstarted one and like a missing one', async () => {
    await asMigrator((tx) =>
      tx.query(
        `insert into trip_event (id, trip_id, step, at, created_by, source, actor_role) values (gen_random_uuid(), $1, 'loading_started', now(), $2, 'admin', 'owner')`,
        [B.trip, owner.id],
      ),
    );
    const started = await cancel(pmA, B.trip);
    const missing = await cancel(pmA, randomUUID());
    expect(started).toEqual(missing);
    // and the steps: record_trip_stage on B or on a missing rotation gives one answer
    const stage = (trip: string) =>
      failure(pmA, `select public.record_trip_stage($1, 'loaded', now(), null, null, null)`, [trip]);
    const sb = await stage(B.trip);
    const sx = await stage(randomUUID());
    expect(sb).not.toBeNull();
    expect(sb?.message).toBe(sx?.message);
    // B's steps were not read by A
    const ev = await as(pmA, (tx) => tx.query(`select 1 from trip_event where trip_id = $1`, [B.trip]));
    expect(ev.rowCount).toBe(0);
    // a direct insert of a step by a plant manager is refused whatever the trip
    for (const trip of [A.trip, B.trip, randomUUID()]) {
      const e = await failure(
        pmA,
        `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'loading_started', now(), $2)`,
        [trip, pmA.id],
      );
      expect(e).not.toBeNull();
    }
  });

  it("cancellations are readable only through the plant: A reads its own reason, never B's or the plant-less one", async () => {
    const mk = async (trip: string) =>
      asMigrator((tx) =>
        tx.query(
          `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, $2, $3)`,
          [trip, `why-${trip}`, owner.id],
        ),
      );
    await mk(N.trip);
    const r = await as(pmA, (tx) =>
      tx.query(`select trip_id from trip_plan_cancellation where trip_id = any($1)`, [[B.trip, N.trip]]),
    );
    expect(r.rowCount).toBe(0);
    const o = await as(owner, (tx) =>
      tx.query(`select trip_id from trip_plan_cancellation where trip_id = $1`, [N.trip]),
    );
    expect(o.rowCount).toBe(1);
  });

  it("start/cancel race, both orders, on the manager's own rotation: whichever commits first wins and the other is refused", async () => {
    const mkTrip = async () => {
      const label = `r${++raceN}`;
      const master = await orderMaster(app, owner.id, `${marker}${label}`);
      const scene = await deliveryScene(app, owner.id, `${marker}${label}`, '2093-01-01');
      const trip = randomUUID();
      await as(owner, async (tx) => {
        await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
        const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, date);
        await tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
           values ($1, $2, $3, $4, 1, $5, 4000, 420, 430, 460, 500, 530, $6)`,
          [trip, randomUUID(), date, o.id, scene.truckId, owner.id],
        );
      });
      return trip;
    };
    const cancelSql = `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'replanned', $2)`;
    const startSql = `select public.record_trip_stage($1, 'loading_started', now(), null, null, null)`;
    const hold = <T>() => {
      let release!: () => void;
      const p = new Promise<void>((r) => (release = r));
      return { p, release, _t: undefined as T | undefined };
    };
    // order 1: the cancellation commits first (held open), the start waits on the rotation's lock, then finds it cancelled
    {
      const trip = await mkTrip();
      const h = hold();
      const entered = hold();
      const c = as(pmA, async (tx) => {
        await tx.query(cancelSql, [trip, pmA.id]);
        entered.release();
        await h.p;
      });
      await entered.p;
      const s = as(pmA, (tx) => tx.query(startSql, [trip])).then(
        () => 'started',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 300));
      h.release();
      await c;
      expect(await s).toMatch(/not a live rotation/);
    }
    // order 2: the start commits first, the cancellation then finds it started
    {
      const trip = await mkTrip();
      const h = hold();
      const entered = hold();
      const s = as(pmA, async (tx) => {
        await tx.query(startSql, [trip]);
        entered.release();
        await h.p;
      });
      await entered.p;
      const c = as(pmA, (tx) => tx.query(cancelSql, [trip, pmA.id])).then(
        () => 'cancelled',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 300));
      h.release();
      await s;
      expect(await c).toMatch(/has started/);
    }
  });
});
