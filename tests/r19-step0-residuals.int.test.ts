import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { insertPurchase, purchaseMaster } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';
import { setReservedBoundary } from './setup-db';

/**
 * R19 step 0: the same whole-tuple rule for receipt_states, stock_arrived_pending and driver_instructions (decision 219's named residuals).
 * REAL purchases, plant confirmations and arrival lines of plant A, plant B and NO plant, with the production boundary ON; own-tuple positive controls;
 * the owner still reads everything.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r0${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
const codes: Record<string, string> = {};
const NOTE = `CANARY-RCPT-${marker}`;

beforeAll(async () => {
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, true);
  w = await plantWorld(app, migrator, marker);
  const pm = await purchaseMaster(app, w.owner.id, marker);
  // [label, purchase plant, confirmation plant, arrived milli]
  const cases: [string, string | null, string | null, number][] = [
    ['own', w.plantA, w.plantA, 1000],
    ['nullplant', null, null, 2000],
    ['purchaseB', w.plantB, w.plantA, 4000],
    ['confB', w.plantA, w.plantB, 8000],
  ];
  for (const [label, purchasePlant, confPlant, milli] of cases) {
    const p = await w.asOwnerIn(w.plantA, (tx) => insertPurchase(tx, w.owner.id, pm));
    if (purchasePlant !== w.plantA)
      await w.sup(`update purchase set plant_id = $2 where id = $1`, [p.id, purchasePlant], ['purchase']);
    codes[label] = p.code;
    const conf = randomUUID();
    await w.sup(
      `insert into receipt_plant_confirmation (id, purchase_id, plant_id, note, confirmed_by) values ($1, $2, $3, $4, $5)`,
      [conf, p.id, confPlant, `${NOTE}-${label}`, w.owner.id],
      ['receipt_plant_confirmation'],
    );
    await w.sup(
      `insert into receipt_arrival_line (id, confirmation_id, purchase_line_id, plant_id, arrived_milli, available)
       select gen_random_uuid(), $1, l.id, $2, $3, true from purchase_line l where l.purchase_id = $4 and l.component_id is not null`,
      [conf, confPlant, milli, p.id],
      ['receipt_arrival_line'],
    );
  }
});
afterAll(async () => {
  await w?.done();
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
  await Promise.all([app.end(), migrator.end()]);
});

describe('R19 step 0: receipt_states and stock_arrived_pending', () => {
  it('receipt_states: the manager reads the confirmation of his own plant and purchase only; no note or purchase code of a no-plant or foreign tuple', async () => {
    const since = '2020-01-01';
    const mine = await w.as(
      w.pmA,
      async (tx) =>
        (
          await tx.query<{ purchase_code: string; note: string }>('select * from public.receipt_states($1)', [
            since,
          ])
        ).rows,
    );
    expect([...new Set(mine.map((r) => r.purchase_code))]).toEqual([codes.own]);
    expect(JSON.stringify(mine)).not.toContain(NOTE + '-nullplant');
    for (const l of ['nullplant', 'purchaseB', 'confB']) expect(JSON.stringify(mine)).not.toContain(codes[l]);
    const all = await w.as(
      w.owner,
      async (tx) =>
        (await tx.query<{ purchase_code: string }>('select * from public.receipt_states($1)', [since])).rows,
    );
    for (const l of Object.keys(codes))
      expect(
        all.some((r) => r.purchase_code === codes[l]),
        `owner sees ${l}`,
      ).toBe(true);
  });

  it('stock_arrived_pending: the manager sums only his own tuple; the owner sums all four', async () => {
    const sum = async (u: typeof w.pmA) =>
      w.as(
        u,
        async (tx) =>
          (
            await tx.query<{ qty_base: string; component_id: string }>(
              'select * from public.stock_arrived_pending(null)',
            )
          ).rows,
      );
    const component = (
      await migrator.query<{ component_id: string }>(
        `select l.component_id from purchase p join purchase_line l on l.purchase_id = p.id where p.code = $1`,
        [codes.own],
      )
    ).rows[0]!.component_id;
    const of = (rows: { qty_base: string; component_id: string }[]) =>
      Number(rows.find((r) => r.component_id === component)?.qty_base ?? 0);
    expect(of(await sum(w.pmA))).toBe(1_000_000);
    expect(of(await sum(w.owner as never))).toBe(15_000_000);
  });
});

describe('R19 step 0: driver_instructions returns a joined truck code only inside the scope', () => {
  it("the joined rotation's truck is shown when it is the driver's own or of the same plant tuple; not for another plant, a plantless order or a truck of B", async () => {
    const day = '2026-10-06';
    const main = await w.newTrip(w.plantA, w.truckA, w.driverA, { day });
    const sameTuple = await w.newTrip(w.plantA, w.truckA, w.driverB, { day }); // another driver, same plant tuple
    const orderB = await w.newTrip(w.plantA, w.truckA, w.driverB, { day });
    await w.sup(
      `update sales_order set plant_id = $2 where id = $1`,
      [orderB.order, w.plantB],
      ['sales_order'],
    );
    const truckOfB = await w.newTrip(w.plantA, w.truckA, w.driverB, { day });
    await w.sup(`update trip_plan set truck_id = $2 where id = $1`, [truckOfB.trip, w.truckB], ['trip_plan']);
    const own2 = await w.newTrip(w.plantA, w.truckA, w.driverA, { day });
    await w.sup(`update sales_order set plant_id = null where id = $1`, [own2.order], ['sales_order']); // his own rotation, odd order: still shown
    const emergency = randomUUID();
    await w.sup(
      `insert into trip_emergency (id, trip_id, driver_id, step, option, at, client_key) values ($1, $2, $3, 'departed', 'breakdown', now(), $4)`,
      [emergency, main.trip, w.driverA, `k-${randomUUID()}`],
      ['trip_emergency'],
    );
    const truckCode = async (id: string) =>
      (
        await migrator.query<{ code: string }>(
          `select t.code from trip_plan p join truck t on t.id = p.truck_id where p.id = $1`,
          [id],
        )
      ).rows[0]!.code;
    const joins: [string, string][] = [];
    for (const [label, t] of [
      ['same', sameTuple],
      ['orderB', orderB],
      ['truckB', truckOfB],
      ['own2', own2],
    ] as const) {
      const id = randomUUID();
      await w.sup(
        `insert into trip_instruction (id, emergency_id, trip_id, kind, join_trip_id, created_by) values ($1, $2, $3, 'join', $4, $5)`,
        [id, emergency, main.trip, t.trip, w.owner.id],
        ['trip_instruction'],
      );
      joins.push([label, id]);
    }
    const rows = await w.as(
      w.driverUserA,
      async (tx) =>
        (
          await tx.query<{ id: string; join_truck_code: string | null }>(
            'select * from public.driver_instructions()',
          )
        ).rows,
    );
    const code = (label: string) =>
      rows.find((r) => r.id === joins.find((j) => j[0] === label)![1])?.join_truck_code;
    expect(code('same'), 'positive control').toBe(await truckCode(sameTuple.trip));
    expect(code('own2'), 'assigned to him').toBe(await truckCode(own2.trip));
    expect(code('orderB')).toBeNull();
    expect(code('truckB')).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(
      (await truckCode(truckOfB.trip)) === (await truckCode(sameTuple.trip))
        ? '__none__'
        : await truckCode(truckOfB.trip),
    );
  });
});
