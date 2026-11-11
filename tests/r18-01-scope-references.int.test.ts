import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { insertDelivery, insertOrder } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R18-01: plant manager A (an app-login session) against REAL parents and children of plant B and of no plant: orders, trucks, drivers, plans, loads,
 * with seeded historical mismatches. One answer for absent and foreign references; the screens' functions return no mismatched row; rows unchanged.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r1${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
const day = (n: number) => `2096-02-${String(10 + n).padStart(2, '0')}`;

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

const asA = { user: '', role: 'plant_manager' };
const planSql = `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
                 values ($1, $2, $3, $4, 1, $5, $6, 1000, 600, 610, 640, 680, 710, $7)`;
/** An order of plant A, B or NO plant (made by the owner in the plant, the plant then stripped by hand for NULL: the order is append-only). */
async function newOrder(plant: string | null, d: string) {
  const inPlant = plant ?? w.plantA;
  const o = await w.asOwnerIn(inPlant, (tx) =>
    insertOrder(tx, w.owner.id, { ...w.master, clientId: w.scene.clientId }, d),
  );
  if (plant === null)
    await w.sup(`update sales_order set plant_id = null where id = $1`, [o.id], ['sales_order']);
  return o;
}

describe("R18-01: a plan cannot be attached to a reference outside the manager's plant, and the refusals are one answer", () => {
  it('order of B, order with NO plant, missing order, truck of B, missing truck, driver of B, missing driver: the same error, nothing inserted', async () => {
    asA.user = w.pmA.id;
    const d = day(1);
    const own = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: d }); // makes driverA known to plant A (a plan of his plant)
    const orderB = await newOrder(w.plantB, d);
    const orderN = await newOrder(null, d);
    const orderA = await newOrder(w.plantA, d);
    const attempts: [string, unknown[]][] = [
      ['order of B', [orderB.id, w.truckA, w.driverA]],
      ['order with no plant', [orderN.id, w.truckA, w.driverA]],
      ['missing order', [randomUUID(), w.truckA, w.driverA]],
      ['truck of B', [orderA.id, w.truckB, w.driverA]],
      ['missing truck', [orderA.id, randomUUID(), w.driverA]],
      ['driver of B', [orderA.id, w.truckA, w.driverB]],
      ['missing driver', [orderA.id, w.truckA, randomUUID()]],
    ];
    const rows = () => w.count('select 1 from trip_plan');
    const audit = () => w.count('select 1 from audit_event');
    const before = [await rows(), await audit()];
    const answers = new Map<string, string>();
    for (const [label, [order, truck, driver]] of attempts) {
      const err = await w.failure(asA, planSql, [
        randomUUID(),
        randomUUID(),
        d,
        order,
        truck,
        driver,
        w.pmA.id,
      ]);
      expect(err, label).not.toBeNull();
      expect(err!.code, label).toBe('42501');
      answers.set(label, err!.message);
    }
    // ONE answer, naming no reference (before the fix: five different texts, and the plantless order was attached)
    expect([...new Set(answers.values())]).toEqual(['trip_plan: reference not available']);
    expect([await rows(), await audit()]).toEqual(before);
    // positive control: his own order, truck and driver are accepted (so the refusals were about the references)
    const planId = randomUUID();
    await w.as(w.pmA, (tx) =>
      tx.query(planSql, [planId, randomUUID(), d, orderA.id, w.truckA, w.driverA, w.pmA.id]),
    );
    expect(await w.count(`select 1 from trip_plan where id = '${planId}' and plant_id = '${w.plantA}'`)).toBe(
      1,
    );
    void own;
  });

  it('a load (delivery) of an order of B or of no plant is refused the same way for a plant manager', async () => {
    const d = day(2);
    const orderB = await newOrder(w.plantB, d);
    const orderN = await newOrder(null, d);
    const before = await w.count('select 1 from delivery');
    const errs: string[] = [];
    for (const o of [orderB, orderN]) {
      const err = await w.failure(
        { user: w.pmA.id, role: 'plant_manager' },
        `insert into delivery (id, order_id, truck_id, recette_id, volume_l, loaded_at, bl_no, created_by)
         values (gen_random_uuid(), $1, $2, $3, 1000, now(), 'BL-R18-' || floor(random()*1e9)::text, $4)`,
        [o.id, w.truckA, w.scene.recetteId, w.pmA.id],
      );
      expect(err).not.toBeNull();
      errs.push(err!.message);
    }
    expect(new Set(errs).size).toBe(1);
    expect(await w.count('select 1 from delivery')).toBe(before);
  });
});

describe("R18-01: historical mismatches are not shown by the screens' functions", () => {
  it('trip_timing: a plan of A on a plantless order does not leak the order code', async () => {
    const d = day(3);
    const t = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: d });
    const ok = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: d });
    await w.sup(`update sales_order set plant_id = null where id = $1`, [t.order], ['sales_order']); // the state the attack produced
    const seen = await w.as(w.pmA, async (tx) =>
      (await tx.query<{ order_code: string }>('select order_code from public.trip_timing($1)', [d])).rows.map(
        (r) => r.order_code,
      ),
    );
    expect(seen).toContain(ok.orderCode);
    expect(seen).not.toContain(t.orderCode);
    // the owner still sees both (nothing was deleted)
    const all = await w.as(w.owner, async (tx) =>
      (await tx.query<{ order_code: string }>('select order_code from public.trip_timing($1)', [d])).rows.map(
        (r) => r.order_code,
      ),
    );
    expect(all).toEqual(expect.arrayContaining([ok.orderCode, t.orderCode]));
  });

  it('dispatch_office: a plan of B on an order of A (and the BL of a load of B) is not returned to manager A; the owner sees it', async () => {
    const d = day(4);
    const good = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: d });
    const mismatched = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: d });
    // a historical mismatch, made by hand (the guards forbid it now): the plan names plant B and B's truck and driver, on an order of A
    await w.sup(
      `update trip_plan set plant_id = $2, truck_id = $3, driver_id = $4 where id = $1`,
      [mismatched.trip, w.plantB, w.truckB, w.driverB],
      ['trip_plan'],
    );
    const seen = async (u: typeof w.pmA) =>
      (
        await w.as(
          u,
          async (tx) =>
            (
              await tx.query<{ trip_id: string; bl_no: string | null }>(
                'select trip_id, bl_no from public.dispatch_office($1)',
                [d],
              )
            ).rows,
        )
      ).map((r) => r.trip_id);
    // the office dispatch is read by office roles and managers; the manager is the scoped one
    expect(await seen(w.pmA)).toEqual([good.trip]);
    expect(await seen(w.owner)).toEqual(expect.arrayContaining([good.trip, mismatched.trip]));
    // a BL of a load of B linked to a stage of A's plan is not shown
    const loadB = await w.plantLoad(w.plantA, mismatched.order, w.truckA);
    await w.sup(`update delivery set plant_id = $2 where id = $1`, [loadB, w.plantB], ['delivery']);
    await w.tap(w.driverUserA, good.trip, 'loaded');
    await w.sup(
      `update trip_event set delivery_id = $2 where trip_id = $1 and step = 'loaded'`,
      [good.trip, loadB],
      ['trip_event'],
    );
    const bl = await w.as(
      w.pmA,
      async (tx) =>
        (
          await tx.query<{ bl_no: string | null }>(
            'select bl_no from public.dispatch_office($1) where trip_id = $2',
            [d, good.trip],
          )
        ).rows[0]!.bl_no,
    );
    expect(bl).toBeNull();
    const blOwner = await w.as(
      w.owner,
      async (tx) =>
        (
          await tx.query<{ bl_no: string | null }>(
            'select bl_no from public.dispatch_office($1) where trip_id = $2',
            [d, good.trip],
          )
        ).rows[0]!.bl_no,
    );
    expect(blOwner).not.toBeNull();
  });

  it("order_timeline: the plan batches, stage events and loads of OTHER plants on an order of A are not in A's timeline", async () => {
    const d = day(5);
    const t = await w.newTrip(w.plantA, w.truckA, w.driverA, { day: d });
    await w.tap(w.driverUserA, t.trip, 'loaded');
    const loadA = await w.plantLoad(w.plantA, t.order, w.truckA);
    // a historical mismatch: a second plan of the SAME order that names plant B, a stage on it, and a load of B
    const extra = randomUUID();
    await w.sup(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by, plant_id)
       values ($1, gen_random_uuid(), $2, $3, 2, $4, $5, 1000, 800, 810, 840, 880, 910, $6, $7)`,
      [extra, d, t.order, w.truckB, w.driverB, w.owner.id, w.plantB],
      ['trip_plan'],
    );
    // a load of B on this order: made on the order (plant A), then moved to plant B by hand
    const loadB = await w.asOwnerIn(w.plantA, async (tx) => {
      const dl = await insertDelivery(
        tx,
        w.owner.id,
        { orderId: t.order, truckId: w.truckA, recetteId: w.scene.recetteId },
        1000,
      );
      return dl.blNo;
    });
    await w.sup(`update delivery set plant_id = $2 where bl_no = $1`, [loadB, w.plantB], ['delivery']);
    const tl = async (u: typeof w.pmA) =>
      (
        await w.as(
          u,
          async (tx) =>
            (
              await tx.query<{ step: string; ref: string | null }>(
                'select step, ref from public.order_timeline($1)',
                [t.order],
              )
            ).rows,
        )
      ).map((r) => `${r.step}:${r.ref}`);
    const mine = await tl(w.pmA);
    const all = await tl(w.owner);
    expect(all.filter((x) => x.startsWith('bl:')).length).toBe(2);
    expect(mine.filter((x) => x.startsWith('bl:'))).toHaveLength(1);
    expect(mine.join()).not.toContain(loadB);
    expect(all.join()).toContain(loadB);
    // the second plan is a second batch only the owner sees ('replanned'): A's timeline has no replan from plant B
    expect(all.some((x) => x.startsWith('replanned'))).toBe(true);
    expect(mine.some((x) => x.startsWith('replanned'))).toBe(false);
    void loadA;
  });
});
