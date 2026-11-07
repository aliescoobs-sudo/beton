import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, createTruck, updatePlant } from '../src/modules/master-data';
import { postponeTrip, reassignTrip, saveDispatch } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  type DeliveryScene,
} from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// R14-01: cancelling, starting and replacing a rotation are one serialized decision. The races are made deterministic: one transaction
// is held open (it has taken its locks and not committed) while the other is started, which must wait, then see the committed state.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 10 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `ds${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
// Each group plans on a day of its own, far from the other suites: the service replans every unstarted rotation of a day.
let dayNo = 0;
const nextDay = () =>
  `2093-${String(1 + Math.floor(dayNo / 25)).padStart(2, '0')}-${String(1 + (dayNo++ % 25)).padStart(2, '0')}`;

let done: () => Promise<void>;
let owner: SessionUser, pmA: SessionUser, partner: SessionUser, support: SessionUser, accountant: SessionUser;
let driver1: SessionUser, driver2: SessionUser;
let plantA = '',
  plantB = '';
let scene: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
let truckA = '',
  truckB = '',
  truckC = '';
let driverRow1 = '',
  driverRow2 = '';

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
    return fn(tx);
  });
const asRole = <T>(u: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);

async function userRow(role: string, plant: string | null): Promise<SessionUser> {
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, $4, 'fr', 'active', true, now(), $5)`,
    [id, `${marker} ${role}`, `${marker}-${role}-${id}@belgobeton.test`, role, plant],
  );
  return {
    id,
    name: `${marker} ${role}`,
    email: `${id}@belgobeton.test`,
    role,
    locale: 'fr',
    twoFactorEnabled: true,
    reenrolRequired: false,
  } as unknown as SessionUser;
}
async function newDriver(name: string, user: SessionUser): Promise<string> {
  const code = `CH-${3000 + Math.floor(Math.random() * 4000)}`;
  const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
  await c.connect();
  try {
    await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
      SYSTEM_ACTOR_ID,
    ]);
    return (
      await c.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, kind, user_id) values (gen_random_uuid(), $1, $2, $3, 'driver', $4) returning id`,
        [code, name, owner.id, user.id],
      )
    ).rows[0]!.id;
  } finally {
    await c.end();
  }
}
const newOrder = (date: string) =>
  asOwner((tx) => insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, date));
/** A planned rotation, written straight into the plan (the plan's own guards apply). */
const newTrip = (
  date: string,
  orderId: string,
  truck: string,
  driver: string | null,
  seq = 1,
  loadMin = 420,
) =>
  asOwner(async (tx) => {
    const id = randomUUID();
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 4000, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        randomUUID(),
        date,
        orderId,
        seq,
        truck,
        driver,
        loadMin,
        loadMin + 10,
        loadMin + 40,
        loadMin + 80,
        loadMin + 110,
        owner.id,
      ],
    );
    return id;
  });
const tapAt = () => new Date(Date.now() - 60_000);
const loadingTap = (tx: pg.PoolClient, trip: string) =>
  tx.query('select public.driver_report($1, $2, $3, $4, null, null)', [
    trip,
    'loading_started',
    tapAt(),
    randomUUID(),
  ]);
const cancel = (tx: pg.PoolClient, trip: string) =>
  tx.query(
    `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'replanned', $2)`,
    [trip, owner.id],
  );
const livePlans = async (date: string, orderId?: string) =>
  (
    await migrator.query<{
      id: string;
      order_id: string;
      seq: number;
      truck_id: string;
      driver_id: string | null;
    }>(
      `select p.id, p.order_id, p.seq, p.truck_id, p.driver_id from trip_plan p
        where p.trip_date = $1 and ($2::uuid is null or p.order_id = $2)
          and not exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id) order by p.order_id, p.seq`,
      [date, orderId ?? null],
    )
  ).rows;

/** A transaction that does `run`, then stays open (locks held, nothing committed) until `release()`. */
function holding<T>(
  open: <R>(fn: (tx: pg.PoolClient) => Promise<R>) => Promise<R>,
  run: (tx: pg.PoolClient) => Promise<T>,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const settled = open(async (tx) => {
    const v = await run(tx);
    ready();
    await gate;
    return v;
  });
  return { isReady, release, settled };
}
/** True when `p` has not settled after a while: it is waiting for a lock. */
const stillWaiting = async (p: Promise<unknown>, ms = 600) =>
  (await Promise.race([
    p.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((r) => setTimeout(() => r('waiting'), ms)),
  ])) === 'waiting';
const asDriver1 = <R>(fn: (tx: pg.PoolClient) => Promise<R>) => asRole(driver1, fn);

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantA = v.plantId;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  partner = v.session('partner') as unknown as SessionUser;
  support = v.session('support') as unknown as SessionUser;
  accountant = v.session('accountant') as unknown as SessionUser;
  master = await orderMaster(app, owner.id, `${marker}a`);
  scene = await deliveryScene(app, owner.id, `${marker}a`, '2093-01-01');
  const b = await createPlant(app, owner, { code: letters(6), name: `DSB ${marker}` });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  driver1 = await userRow('driver', null);
  driver2 = await userRow('driver', null);
  driverRow1 = await newDriver(`Chauffeur un ${marker}`, driver1);
  driverRow2 = await newDriver(`Chauffeur deux ${marker}`, driver2);
  const mk = async (plant: string, tag: string) => {
    for (let i = 0; i < 30; i++) {
      const r = await createTruck(app, owner, {
        code: `T${100 + Math.floor(Math.random() * 890)}`,
        plate: `DS-${marker.slice(0, 8)}-${tag}${i}`,
        plantId: plant,
      });
      if (r.ok) return r.value.id;
    }
    throw new Error('no truck code');
  };
  truckA = await mk(plantA, 'a');
  truckB = await mk(plantA, 'b');
  truckC = await mk(plantA, 'c');
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('"started" includes the driver\'s report that loading began', () => {
  it('a rotation with only that report cannot be moved, postponed or cancelled', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const trip = await newTrip(date, order.id, truckA, driverRow1);
    await asDriver1((tx) => loadingTap(tx, trip));
    // no trip_event exists: the old predicate saw an unstarted rotation
    expect((await migrator.query(`select 1 from trip_event where trip_id = $1`, [trip])).rowCount).toBe(0);
    expect(
      await reassignTrip(app, pmA, {
        tripId: trip,
        truckId: truckB,
        driverId: null,
        reason: 'Retard annoncé',
      }),
    ).toEqual({ ok: false, error: 'STARTED' });
    expect(await postponeTrip(app, pmA, { tripId: trip, reason: 'Retard annoncé' })).toEqual({
      ok: false,
      error: 'STARTED',
    });
    await expect(asOwner((tx) => cancel(tx, trip))).rejects.toThrow(/has started/);
    expect((await livePlans(date)).map((p) => p.id)).toEqual([trip]);
  });
});

describe('cancellation against start, one serialized decision', () => {
  it('a postponement waits for a start in flight, then sees it and refuses', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const trip = await newTrip(date, order.id, truckA, driverRow1);
    const start = holding(asDriver1, (tx) => loadingTap(tx, trip)); // the driver's tap, not yet committed
    await start.isReady;
    const postponing = postponeTrip(app, pmA, { tripId: trip, reason: 'Le client reporte' });
    expect(await stillWaiting(postponing)).toBe(true);
    start.release();
    await start.settled;
    expect(await postponing).toEqual({ ok: false, error: 'STARTED' });
    expect(
      (await migrator.query(`select 1 from trip_plan_cancellation where trip_id = $1`, [trip])).rowCount,
    ).toBe(0);
  });

  it("the driver's tap waits for a cancellation in flight, then finds the rotation cancelled", async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const trip = await newTrip(date, order.id, truckA, driverRow1);
    const cancelling = holding(asOwner, (tx) => cancel(tx, trip)); // not yet committed
    await cancelling.isReady;
    const tapping = asDriver1((tx) => loadingTap(tx, trip));
    const outcome = tapping.then(
      () => 'tapped',
      (e: Error) => e.message,
    );
    expect(await stillWaiting(tapping)).toBe(true);
    cancelling.release();
    await cancelling.settled;
    expect(await outcome).toMatch(/not a live rotation/);
    expect(
      (await migrator.query(`select 1 from trip_driver_report where trip_id = $1`, [trip])).rowCount,
    ).toBe(0);
  });

  it("the cancellation trigger takes the event writer's lock: an event in flight blocks it, which then refuses", async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const trip = await newTrip(date, order.id, scene.truckId, driverRow1);
    const loading = holding(asOwner, async (tx) => {
      const d = await insertDelivery(
        tx,
        owner.id,
        { orderId: order.id, truckId: scene.truckId, recetteId: scene.recetteId },
        1000,
      );
      const id = (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo]))
        .rows[0]!.id;
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now(), $2, $3)`,
        [trip, id, owner.id],
      );
    });
    await loading.isReady;
    const cancelling = asOwner((tx) => cancel(tx, trip));
    const outcome = cancelling.then(
      () => 'cancelled',
      (e: Error) => e.message,
    );
    expect(await stillWaiting(cancelling)).toBe(true);
    loading.release();
    await loading.settled;
    expect(await outcome).toMatch(/has started/);
    expect((await livePlans(date)).map((p) => p.id)).toEqual([trip]);
  });
});

describe('simultaneous changes of one day', () => {
  it('two reassignments of the same rotation: one wins, the other re-reads after the lock and finds the plan changed', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const trip = await newTrip(date, order.id, truckA, driverRow1);
    const go = (truck: string) =>
      reassignTrip(app, pmA, {
        tripId: trip,
        truckId: truck,
        driverId: null,
        reason: 'Le camion revient trop tard',
      });
    const results = await Promise.all([go(truckB), go(truckC)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: 'CONFLICT' });
    const live = await livePlans(date, order.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(trip);
    expect(
      (await migrator.query(`select 1 from trip_dispatch_change where old_trip_id = $1`, [trip])).rowCount,
    ).toBe(1);
  });

  it('two reassignments of different rotations: serialized; the loser re-reads the changed day, nothing is doubled', async () => {
    const date = nextDay();
    const o1 = await newOrder(date);
    const o2 = await newOrder(date);
    const t1 = await newTrip(date, o1.id, truckA, null);
    const t2 = await newTrip(date, o2.id, truckB, null);
    const results = await Promise.all([
      reassignTrip(app, pmA, { tripId: t1, truckId: truckC, driverId: null, reason: 'Panne probable' }),
      reassignTrip(app, pmA, { tripId: t2, truckId: truckC, driverId: null, reason: 'Panne probable' }),
    ]);
    // a reassignment plans the day's unstarted rotations again, so the second one's rotation is a new row by the time it gets the lock
    expect(
      results.filter((r) => r.ok),
      JSON.stringify(results),
    ).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: 'CONFLICT' });
    const live = await livePlans(date);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((p) => `${p.order_id}:${p.seq}`)).size).toBe(2);
    expect(
      (await migrator.query(`select 1 from trip_dispatch_change where old_trip_id in ($1, $2)`, [t1, t2]))
        .rowCount,
    ).toBe(1);
  });

  it('a reassignment against a start in flight: the start wins and the move is refused', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const trip = await newTrip(date, order.id, truckA, driverRow1);
    const start = holding(asDriver1, (tx) => loadingTap(tx, trip));
    await start.isReady;
    const moving = reassignTrip(app, pmA, {
      tripId: trip,
      truckId: truckB,
      driverId: null,
      reason: 'Trop de retard',
    });
    expect(await stillWaiting(moving)).toBe(true);
    start.release();
    await start.settled;
    expect(await moving).toEqual({ ok: false, error: 'STARTED' });
    expect((await livePlans(date)).map((p) => p.id)).toEqual([trip]);
  });

  it('two saves of the same work: the second replaces the first, one live rotation per work item', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const rotation = (truck: string) => ({ orderId: order.id, truckId: truck, volumeL: 4000 });
    const save = (truck: string) =>
      saveDispatch(app, owner, { date, rotations: [rotation(truck), rotation(truck)] });
    const results = await Promise.all([save(truckA), save(truckB)]);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    const live = await livePlans(date, order.id);
    expect(live).toHaveLength(2);
    expect(live.map((p) => p.seq)).toEqual([1, 2]);
    // both batches exist in history, the first one cancelled by the second
    const batches = await migrator.query(`select distinct batch_id from trip_plan where trip_date = $1`, [
      date,
    ]);
    expect(batches.rowCount).toBe(2);
  });

  it('the plan itself refuses a second live rotation for the same work item, whatever the batch', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    await newTrip(date, order.id, truckA, null, 1);
    await expect(newTrip(date, order.id, truckB, null, 1, 800)).rejects.toMatchObject({ code: '23505' });
    // after a cancellation the number is free again
    const live = await livePlans(date, order.id);
    await asOwner((tx) => cancel(tx, live[0]!.id));
    await expect(newTrip(date, order.id, truckB, null, 1, 800)).resolves.toBeTruthy();
  });

  it('a rotation that stays keeps its number: the new ones of the order continue after it', async () => {
    const date = nextDay();
    const order = await newOrder(date);
    const started = await newTrip(date, order.id, truckA, driverRow1, 1);
    await asDriver1((tx) => loadingTap(tx, started));
    const r = await saveDispatch(app, owner, {
      date,
      rotations: [{ orderId: order.id, truckId: truckB, volumeL: 4000 }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await livePlans(date, order.id)).map((p) => p.seq)).toEqual([1, 2]);
  });
});

describe('the overlap policy: no double-booking without an audited override', () => {
  const plan = (date: string, orderId: string, orderId2: string, extra: object = {}) => ({
    date,
    rotations: [
      { orderId, truckId: truckA, driverId: driverRow1, volumeL: 4000 },
      { orderId: orderId2, truckId: truckB, driverId: driverRow1, volumeL: 4000 },
    ],
    ...extra,
  });

  it('a driver on two trucks at once is refused, nothing is written', async () => {
    const date = nextDay();
    const [o1, o2] = [await newOrder(date), await newOrder(date)];
    expect(await saveDispatch(app, owner, plan(date, o1.id, o2.id))).toEqual({ ok: false, error: 'OVERLAP' });
    expect(await saveDispatch(app, owner, plan(date, o1.id, o2.id, { overlapReason: 'ok' }))).toEqual({
      ok: false,
      error: 'OVERLAP',
    });
    expect(await livePlans(date)).toHaveLength(0);
  });

  it('with an explicit reason it is saved, reported back, recorded and audited; the reason is restricted', async () => {
    const date = nextDay();
    const [o1, o2] = [await newOrder(date), await newOrder(date)];
    const reason = `Chauffeur seul ce jour ${marker}`;
    const r = await saveDispatch(app, owner, plan(date, o1.id, o2.id, { overlapReason: reason }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.overlapOverride).toBe(true);
    expect(r.value.conflicts.map((c) => c.kind)).toContain('DRIVER_OVERLAP');
    const row = await migrator.query<{ kinds: string[]; reason: string; plant_id: string | null }>(
      `select kinds, reason, plant_id from trip_overlap_override where batch_id = $1`,
      [r.value.batchId],
    );
    expect(row.rows[0]).toMatchObject({ kinds: ['driver'], reason });
    expect(
      (
        await migrator.query(
          `select 1 from audit_event where table_name = 'trip_overlap_override' and action = 'insert'`,
        )
      ).rowCount,
    ).toBeGreaterThan(0);
    const reads = async (u: SessionUser) =>
      (await asRole(u, (tx) => tx.query(`select 1 from trip_overlap_override where reason = $1`, [reason])))
        .rowCount;
    expect(await reads(owner)).toBe(1);
    for (const u of [partner, support, accountant]) expect(await reads(u), u.role).toBe(0);
  });

  it('a partner cannot give the override (the door is for the owner, app_admin and plant manager)', async () => {
    const date = nextDay();
    const [o1, o2] = [await newOrder(date), await newOrder(date)];
    expect(
      await saveDispatch(app, partner, plan(date, o1.id, o2.id, { overlapReason: 'Je le veux' })),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await livePlans(date)).toHaveLength(0);
  });

  it('a reassignment onto a driver who is busy on another truck is refused, or accepted under an override and reported', async () => {
    const date = nextDay();
    const [o1, o2] = [await newOrder(date), await newOrder(date)];
    const t1 = await newTrip(date, o1.id, truckA, driverRow1);
    await newTrip(date, o2.id, truckB, driverRow2);
    const move = (extra: object = {}) =>
      reassignTrip(app, pmA, {
        tripId: t1,
        truckId: truckC,
        driverId: driverRow2,
        reason: 'Panne du premier camion',
        ...extra,
      });
    expect(await move()).toEqual({ ok: false, error: 'OVERLAP' });
    expect((await livePlans(date, o1.id)).map((p) => p.id)).toEqual([t1]); // nothing changed
    const r = await move({ overlapReason: 'Seul chauffeur disponible' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.conflicts).toContain('DRIVER_OVERLAP');
    expect(r.value.overlapOverride).toBe(true);
  });

  it('what a reassignment leaves wrong (no driver, say) is returned to the caller, not dropped', async () => {
    const date = nextDay();
    const o1 = await newOrder(date);
    const t1 = await newTrip(date, o1.id, truckA, driverRow1);
    const r = await reassignTrip(app, pmA, {
      tripId: t1,
      truckId: truckB,
      driverId: null,
      reason: 'Panne du camion',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.conflicts).toContain('NO_DRIVER');
  });

  it('a reassignment answers only for the rotation it moves: an unrelated double-booking of the day is reported, not refused', async () => {
    const date = nextDay();
    const [o1, o2, o3] = [await newOrder(date), await newOrder(date), await newOrder(date)];
    // the same driver on two trucks at once, written straight into the plan (what another writer, or an old day, may have left)
    await newTrip(date, o1.id, truckA, driverRow1);
    await newTrip(date, o2.id, truckB, driverRow1);
    const t3 = await newTrip(date, o3.id, truckC, null);
    const r = await reassignTrip(app, pmA, {
      tripId: t3,
      truckId: truckA,
      driverId: null,
      reason: 'Camion plus proche',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.conflicts).toContain('DRIVER_OVERLAP');
    expect(r.value.overlapOverride).toBe(false);
  });
});
