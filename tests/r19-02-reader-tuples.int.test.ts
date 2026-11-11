import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setReservedBoundary } from './setup-db';
import { testEnv } from './db-env';
import { insertOrder } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R19-02: related-row and NULL-plan leaks on READS. Plant manager A (an app-login session, the production boundary ON) reads through each sibling reader
 * of R18-01 over REAL tuples with seeded historical mismatches: a rotation with NO plant (plan and order), a plan of A on an order of B, a plan of A on
 * an order with no plant, a plan of A whose linked load belongs to an order of B, a load of A that sits on plant B, a pump job of A on an order of B.
 * For each reader: the manager gets his own tuple (positive control), none of the mismatched tuples (the serialized payload carries no canary),
 * and the owner still sees everything (nothing was deleted).
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r2${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const DAY = '2026-10-05'; // a past business day: the "unconfirmed" delay of the exceptions has elapsed
let w: World;

interface Trip {
  trip: string;
  order: string;
  orderCode: string;
}
let own: Trip; // plant A / order A / truck A / driver A: the positive control
let nullPlan: Trip; // no plant on the plan or the order (legacy), with an emergency note canary
let orderB: Trip; // plan A on an order of B
let orderN: Trip; // plan A on an order with no plant
let foreignLoad: Trip; // plan A, order A, but its 'loaded' stage links a load of an order of B
let loadForeign = ''; // the load of an order of B
let loadOwn = ''; // a load of order A on plant A
let loadOnB = ''; // a load of order A that sits on plant B (historical)
let loadNullOrder = ''; // a load of plant A whose order has no plant
const NOTE = `CANARY-NOTE-${marker}`;

const insertEvent = (trip: string, step: string, over: Record<string, unknown> = {}) =>
  w.sup(
    `insert into trip_event (id, trip_id, step, at, delivery_id, created_by, actor_role, source, implicit, created_at)
     values (gen_random_uuid(), $1, $2, now(), $3, $4, $5, $6, false, clock_timestamp())`,
    [trip, step, over.delivery ?? null, w.owner.id, over.actorRole ?? 'driver', over.source ?? 'driver'],
    ['trip_event'],
  );
const setOrderPlant = (order: string, plant: string | null) =>
  w.sup(`update sales_order set plant_id = $2 where id = $1`, [order, plant], ['sales_order']);
const asMgr = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => w.as(w.pmA, fn);
const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => w.as(w.owner, fn);
const rowsOf = async <T extends pg.QueryResultRow>(
  as: typeof asMgr,
  sql: string,
  args: unknown[] = [],
): Promise<T[]> => as(async (tx) => (await tx.query<T>(sql, args)).rows);
const text = (rows: unknown) => JSON.stringify(rows);

beforeAll(async () => {
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, true);
  w = await plantWorld(app, migrator, marker);
  own = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: DAY });
  nullPlan = await w.newTrip(w.plantA, w.truckN, w.driverA, { day: DAY, nullPlant: true });
  orderB = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: DAY });
  await setOrderPlant(orderB.order, w.plantB);
  orderN = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: DAY });
  await setOrderPlant(orderN.order, null);
  foreignLoad = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: DAY });
  // a real order and load of plant B
  const ob = await w.newTrip(w.plantB, w.truckB, w.driverB, { day: DAY });
  loadForeign = await w.plantLoad(w.plantB, ob.order, w.truckB);
  await insertEvent(foreignLoad.trip, 'loaded', {
    delivery: loadForeign,
    source: 'plant',
    actorRole: 'plant_manager',
  });
  // loads of order A: one on plant A, one that sits on plant B; and a load of plant A on an order with no plant
  loadOwn = await w.plantLoad(w.plantA, own.order, w.truckA);
  loadOnB = await w.plantLoad(w.plantA, own.order, w.truckA);
  await w.sup(`update delivery set plant_id = $2 where id = $1`, [loadOnB, w.plantB], ['delivery']);
  loadNullOrder = await w.plantLoad(w.plantA, orderN.order, w.truckA);
  // emergencies: one per tuple, each with a note
  for (const [t, label] of [
    [own, 'OWN'],
    [nullPlan, 'NULLPLAN'],
    [orderB, 'ORDERB'],
    [orderN, 'ORDERN'],
  ] as const)
    await w.sup(
      `insert into trip_emergency (id, trip_id, driver_id, step, option, note, at, client_key)
       values (gen_random_uuid(), $1, $2, 'departed', 'breakdown', $3, now(), $4)`,
      [t.trip, w.driverA, `${NOTE}-${label}`, `k-${randomUUID()}`],
      ['trip_emergency'],
    );
  // a driver-declared end of unloading on each rotation, for the exceptions reader
  for (const t of [own, nullPlan, orderB, orderN, foreignLoad])
    await insertEvent(t.trip, 'unloading_finished');
});
afterAll(async () => {
  // leave no open pump conflict or pump job in the shared database (other suites insert their own open conflicts)
  await w
    ?.sup(
      `update pump_conflict set resolved_at = now(), resolved_by = $1 where resolved_at is null and job_date = $2`,
      [w.owner.id, DAY],
      ['pump_conflict'],
    )
    .catch(() => undefined);
  await w?.done();
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
  await Promise.all([app.end(), migrator.end()]);
});

describe('R19-02: emergencies_open — no NULL-plan exception for a plant manager, and the whole tuple', () => {
  it('the manager reads the emergency of his own rotation only; no note, driver, truck or client of a plan with no plant or an order of another plant', async () => {
    const mine = await rowsOf<{ note: string; order_code: string }>(
      asMgr,
      'select * from public.emergencies_open()',
    );
    expect(mine.map((r) => r.note)).toEqual([`${NOTE}-OWN`]);
    const payload = text(mine);
    for (const t of [nullPlan, orderB, orderN]) expect(payload).not.toContain(t.orderCode);
    for (const label of ['NULLPLAN', 'ORDERB', 'ORDERN']) expect(payload).not.toContain(`${NOTE}-${label}`);
    // nothing was deleted: the owner still reads all four
    const all = await rowsOf<{ note: string }>(asOwner, 'select * from public.emergencies_open()');
    expect(
      all
        .map((r) => r.note)
        .filter((n) => n?.startsWith(NOTE))
        .sort(),
    ).toEqual(['OWN', 'NULLPLAN', 'ORDERB', 'ORDERN'].map((l) => `${NOTE}-${l}`).sort());
  });
});

describe('R19-02: trip_delivery_exceptions — parent and child tuples, and the order aggregates', () => {
  it("declared-without-record rows exist only for rotations whose plan, order and truck are the manager's; the linked foreign load hides its rotation", async () => {
    const q = 'select * from public.trip_delivery_exceptions($1, $1)';
    const mine = await rowsOf<{ kind: string; order_code: string; trip_id: string }>(asMgr, q, [DAY]);
    const codes = new Set(mine.map((r) => r.order_code));
    expect(codes.has(own.orderCode), 'positive control: his own rotation').toBe(true);
    for (const t of [nullPlan, orderB, orderN, foreignLoad]) {
      expect(codes.has(t.orderCode), `a mismatched tuple (${t.orderCode})`).toBe(false);
    }
    const all = new Set((await rowsOf<{ order_code: string }>(asOwner, q, [DAY])).map((r) => r.order_code));
    for (const t of [own, nullPlan, orderB, orderN])
      expect(all.has(t.orderCode), 'the owner still sees it').toBe(true);
  });

  it("the order aggregate counts only the manager's loads: a load of the order that sits on plant B is not summed into what he sees", async () => {
    // the rotation's order has two loads (A: 1000 L, and one that sits on B: 1000 L); the declared end of unloading makes "order_differs" compare the order with them
    const q = `select plant_volume_l from public.trip_delivery_exceptions($1, $1) where kind = 'order_differs' and order_code = $2`;
    const mine = await rowsOf<{ plant_volume_l: number }>(asMgr, q, [DAY, own.orderCode]);
    const owner = await rowsOf<{ plant_volume_l: number }>(asOwner, q, [DAY, own.orderCode]);
    expect(owner.map((r) => r.plant_volume_l)).toEqual([2000]);
    expect(mine.map((r) => r.plant_volume_l)).toEqual([1000]);
  });
});

describe('R19-02: trip_stages — the stage rows and "load linked" follow the tuple', () => {
  it('the manager gets the stages of his own rotation only; a link to a load of another order is not shown as a linked load', async () => {
    const q = 'select trip_id, step, load_linked from public.trip_stages($1)';
    const mine = await rowsOf<{ trip_id: string; step: string; load_linked: boolean }>(asMgr, q, [DAY]);
    const trips = new Set(mine.map((r) => r.trip_id));
    expect(trips.has(own.trip), 'positive control').toBe(true);
    for (const t of [nullPlan, orderB, orderN])
      expect(trips.has(t.trip), `${t.orderCode} must not be listed`).toBe(false);
    // the rotation of his own plant and order whose 'loaded' stage links a load of an order of B: listed (it is his), but the foreign load is not "linked"
    const loaded = mine.find((r) => r.trip_id === foreignLoad.trip && r.step === 'loaded');
    expect(loaded?.load_linked).toBe(false);
    const all = await rowsOf<{ trip_id: string }>(asOwner, q, [DAY]);
    for (const t of [own, nullPlan, orderB, orderN])
      expect(
        all.some((r) => r.trip_id === t.trip),
        'the owner still sees it',
      ).toBe(true);
  });
});

describe('R19-02: the BL (delivery note) and the order chain follow the delivery AND the order', () => {
  it('delivery_note: his own load is printed; a load of his order that sits on plant B, and a load on an order with no plant, are not', async () => {
    const note = (id: string) =>
      rowsOf<{ bl_no: string; order_code: string }>(asMgr, 'select * from public.delivery_note($1)', [id]);
    expect((await note(loadOwn)).map((r) => r.order_code)).toEqual([own.orderCode]);
    expect(await note(loadOnB)).toEqual([]);
    expect(await note(loadNullOrder)).toEqual([]);
    expect(await note(loadForeign)).toEqual([]);
    const ownerSees = async (id: string) =>
      (await rowsOf(asOwner, 'select * from public.delivery_note($1)', [id])).length;
    expect([await ownerSees(loadOwn), await ownerSees(loadOnB), await ownerSees(loadNullOrder)]).toEqual([
      1, 1, 1,
    ]);
  });

  it('order_chain: no order of B or with no plant; the loaded volume of his order counts only the loads of his plant', async () => {
    const chain = (as: typeof asMgr) =>
      rowsOf<{ code: string; loaded_l: string }>(as, 'select code, loaded_l from public.order_chain()');
    const mine = await chain(asMgr);
    const byCode = new Map(mine.map((r) => [r.code, Number(r.loaded_l)]));
    expect(byCode.get(own.orderCode)).toBe(1000); // not 2000: the load that sits on plant B is not his
    for (const t of [orderB, orderN, nullPlan]) expect(byCode.has(t.orderCode), t.orderCode).toBe(false);
    const all = new Map((await chain(asOwner)).map((r) => [r.code, Number(r.loaded_l)]));
    expect(all.get(own.orderCode)).toBe(2000);
    for (const t of [orderB, orderN, nullPlan])
      expect(all.has(t.orderCode), `owner sees ${t.orderCode}`).toBe(true);
  });
});

describe('R19-02: the pump readers follow the job AND its joined order, trip and second job', () => {
  it('pump_board, pump_waiting and pump_conflicts show the manager his own tuples only', async () => {
    const mkJob = async (order: string, label: string) => {
      const id = randomUUID();
      await w.sup(
        `insert into pump_job (id, job_date, pump_id, operator_id, site_label, created_by, order_id, plant_id, on_site_min, planned_m3)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 480, 10)`,
        [id, DAY, w.truckA, w.driverA, label, w.owner.id, order, w.plantA],
        ['pump_job'],
      );
      await w.sup(
        `insert into order_pump (order_id, pumped, updated_by) values ($1, true, $2) on conflict do nothing`,
        [order, w.owner.id],
        ['order_pump'],
      );
      await w.sup(
        `insert into pump_conflict (id, kind, job_date, order_id, job_id, plant_id) values (gen_random_uuid(), 'pump_double_booked', $1, $2, $3, $4)`,
        [DAY, order, id, w.plantA],
        ['pump_conflict'],
      );
      return id;
    };
    const jOwn = await mkJob(own.order, `PUMP-OWN-${marker}`);
    const jB = await mkJob(orderB.order, `PUMP-ORDERB-${marker}`);
    const jN = await mkJob(orderN.order, `PUMP-ORDERN-${marker}`);
    const board = (as: typeof asMgr) =>
      rowsOf<{ job_id: string; order_code: string }>(as, 'select * from public.pump_board($1)', [DAY]);
    const mine = await board(asMgr);
    expect(mine.map((r) => r.job_id)).toContain(jOwn);
    expect(mine.map((r) => r.job_id)).not.toContain(jB);
    expect(mine.map((r) => r.job_id)).not.toContain(jN);
    expect(text(mine)).not.toContain(orderB.orderCode);
    expect(text(mine)).not.toContain(orderN.orderCode);
    const all = (await board(asOwner)).map((r) => r.job_id);
    expect([jOwn, jB, jN].every((j) => all.includes(j))).toBe(true);
    // waiting: orders flagged "pumped" with no job on site
    const waiting = await rowsOf<{ order_code: string }>(asMgr, 'select * from public.pump_waiting($1)', [
      DAY,
    ]);
    expect(text(waiting)).not.toContain(orderB.orderCode);
    expect(text(waiting)).not.toContain(orderN.orderCode);
    // conflicts
    const conflicts = await rowsOf<{ order_code: string }>(asMgr, 'select * from public.pump_conflicts($1)', [
      DAY,
    ]);
    const codes = conflicts.map((r) => r.order_code);
    expect(codes).toContain(own.orderCode);
    expect(codes).not.toContain(orderB.orderCode);
    expect(codes).not.toContain(orderN.orderCode);
    const allConf = (
      await rowsOf<{ order_code: string }>(asOwner, 'select * from public.pump_conflicts($1)', [DAY])
    ).map((r) => r.order_code);
    expect([own, orderB, orderN].every((t) => allConf.includes(t.orderCode))).toBe(true);
  });
});

describe('R19-02: the phone (driver_trips) shows only a rotation whose plan and order agree, and the BL of its own order', () => {
  it('the assigned driver gets his consistent rotation with its load; a plan on an order of another plant is not served; a foreign linked load gives no BL', async () => {
    const trips = await w.as(
      w.driverUserA,
      async (tx) =>
        (
          await tx.query<{ trip_id: string; order_code: string; bl_no: string | null }>(
            'select * from public.driver_trips($1)',
            [DAY],
          )
        ).rows,
    );
    const byTrip = new Map(trips.map((r) => [r.trip_id, r]));
    expect(byTrip.has(own.trip), 'positive control').toBe(true);
    expect(byTrip.has(orderB.trip), 'plan of A on an order of B').toBe(false);
    expect(byTrip.has(orderN.trip), 'plan of A on an order with no plant').toBe(false);
    expect(text(trips)).not.toContain(orderB.orderCode);
    expect(text(trips)).not.toContain(orderN.orderCode);
    // the rotation whose 'loaded' stage links a load of an order of B: served, but never with that load's BL number
    const foreign = byTrip.get(foreignLoad.trip);
    expect(foreign, 'his rotation is served').toBeTruthy();
    const foreignBl = (
      await migrator.query<{ bl_no: string }>('select bl_no from delivery where id = $1', [loadForeign])
    ).rows[0]!.bl_no;
    expect(foreign!.bl_no).toBeNull();
    expect(text(trips)).not.toContain(foreignBl);
    void insertOrder;
  });
});
