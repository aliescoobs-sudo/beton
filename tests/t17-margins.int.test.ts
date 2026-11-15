import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrder } from '../src/modules/ledger';
import { cancelLoad } from '../src/modules/operations';
import {
  marginBp,
  marginsOf,
  salePriceCentimes,
  costBlocks,
  mulDivRound,
} from '../src/modules/operations/domain/cost-arithmetic';
import { listGridInForce } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { insertDelivery, insertOrder, orderMaster, type OrderMaster } from './helpers/ledger-fixtures';
import { noActorOffenders } from './helpers/no-actor-sweep';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * T17 (SPEC-cost-margin §6, §9, §10; D239 to D243): the grid reference (G8), the margin read doors (G9), the pump check (G10), the fuel check (G11).
 * Fictitious A1 data; refusals assert the SQLSTATE; no cost, margin or snapshot is ever shown to a role outside owner and app_admin.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `t17a${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const call = (u: U, sql: string, params: unknown[] = []) => w.as(u, (tx) => tx.query(sql, params));

type Fx = { typeId: string; recetteId: string; priceId: string };
let fxB25P: Fx;
let fxB20G: Fx;
let base: OrderMaster;
// February: the A1 data is in force from 2026-01-01, and tests/t16-cost-snapshot adds a second recette of the shared fictitious class from 2026-03-01
const D1 = '2026-02-10';
const D2 = '2026-02-11';

/** An order of a fictitious FX class (with a selling price of 780,00 per m3) and a BL of it in plant A. */
async function loadOf(
  fx: Fx,
  volumeL: number,
  method: 'GOULOTTE' | 'POMPE' | null,
  loadDate = D1,
  truck = w.truckA,
  plant = w.plantA,
) {
  const master = { ...base, typeId: fx.typeId, sellingPriceId: fx.priceId, clientId: w.scene.clientId };
  const o = await w.asOwnerIn(plant, (tx) => insertOrder(tx, w.owner.id, master, '2026-06-02', null, method));
  const d = await w.asOwnerIn(plant, (tx) =>
    insertDelivery(
      tx,
      w.owner.id,
      { orderId: o.id, truckId: truck, recetteId: fx.recetteId },
      volumeL,
      2026,
      null,
      loadDate,
    ),
  );
  const row = await w.sup<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo]);
  return { order: o.id, id: row[0]!.id, blNo: d.blNo };
}
/** A pump job of the world's client on a day (the pump truck is a truck of plant A, the operator a driver). */
const pumpJob = (
  day: string,
  plant: string | null = null,
  client: string | null = w.scene.clientId,
  pump = w.truckA,
) =>
  w.sup(
    `insert into pump_job (id, job_date, pump_id, operator_id, client_id, site_label, plant_id, created_by) values (gen_random_uuid(), $1, $2, $3, $4, 'chantier fictif', $5, $6)`,
    [day, pump, w.driverA, client, plant, w.owner.id],
  );

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
  base = await orderMaster(app, w.owner.id, `${marker}a`);
  const fx = async (c: string) => {
    const [row] = await w.sup<{ t: string; r: string }>(
      `select t.id t, r.id r from concrete_type t join recette r on r.concrete_type_id = t.id where t.code = $1`,
      [c],
    );
    // another suite of the same run may have made the 780,00 price of this fictitious class: take it, or make it (a race loses to the same row)
    const find = () =>
      w.sup<{ id: string }>(
        `select id from selling_price where concrete_type_id = $1 and client_id is null and plant_id is null and price_ht_per_m3_centimes = 78000 order by effective_from desc limit 1`,
        [row!.t],
      );
    let price = await find();
    if (!price[0]) {
      try {
        price = await w.sup<{ id: string }>(
          `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
           values (gen_random_uuid(), $1, null, 78000, '2026-01-01', $2) returning id`,
          [row!.t, w.owner.id],
        );
      } catch {
        price = await find();
      }
    }
    return { typeId: row!.t, recetteId: row!.r, priceId: price[0]!.id };
  };
  fxB25P = await fx('FXB25P');
  fxB20G = await fx('FXB20G');
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('T17 G8: the grid is a reference (D239)', () => {
  it('owner, app_admin and office_sales read the grid in force; every other role gets nothing and the door itself refuses them', async () => {
    for (const u of [w.owner, w.appAdmin, w.sales]) {
      const g = await listGridInForce(app, u as unknown as SessionUser, '2099-01-01');
      expect(g.length, u.role).toBeGreaterThan(0);
      expect(g.every((x) => x.priceCentimes > 0 && ['GOULOTTE', 'POMPE'].includes(x.method))).toBe(true);
      // one row per (class, method): the latest version in force
      expect(new Set(g.map((x) => `${x.classCode}|${x.method}`)).size).toBe(g.length);
    }
    for (const u of [w.pmA, w.purchases, w.accountant, w.partner, w.support, w.driverUserA]) {
      expect(await listGridInForce(app, u as unknown as SessionUser, '2099-01-01'), u.role).toEqual([]);
      expect(await code(() => call(u, 'select * from public.price_grid_list()')), u.role).toBe('42501');
    }
    // before the first version there is no price in force
    expect(await listGridInForce(app, w.owner as unknown as SessionUser, '1999-01-01')).toEqual([]);
  });

  it('the grid price is never written into selling_price: an order is priced by selling_price whatever the grid says', async () => {
    const m = { ...(await orderMaster(app, w.owner.id, `${marker}a`)), clientId: w.scene.clientId };
    const before = (await w.sup<{ c: string }>('select count(*)::text c from selling_price'))[0]!.c;
    const made = await createOrder(
      app,
      w.owner as unknown as SessionUser,
      {
        clientId: m.clientId,
        plantId: w.plantA,
        concreteTypeId: m.typeId,
        dischargeMethod: 'POMPE',
        volumeL: 5000,
        deliveryDate: '2026-06-03',
        plan: { preset: 'cash' },
      },
      { today: '2026-06-01' },
    );
    if (!made.ok) throw new Error(made.error);
    const o = (
      await w.sup<{ unit: string; sp: string; m: string }>(
        `select o.unit_price_ht_centimes::text unit, p.price_ht_per_m3_centimes::text sp, o.discharge_method m
           from sales_order o join selling_price p on p.id = o.selling_price_id where o.id = $1`,
        [made.value.id],
      )
    )[0]!;
    expect(o.m).toBe('POMPE');
    // the order's price is the selling price, to the centime, and the grid left selling_price untouched
    expect(o.unit).toBe(o.sp);
    expect((await w.sup<{ c: string }>('select count(*)::text c from selling_price'))[0]!.c).toBe(before);
  });
});

type LRow = Record<string, string | number | boolean | null | string[]>;
const list = (u: U, scope = 'all', over: Partial<Record<string, unknown>> = {}) =>
  call(u, `select * from public.bl_margin_list($1, $2, $3, $4, $5, $6, $7, $8)`, [
    over.from ?? null,
    over.to ?? null,
    over.plant ?? w.plantA,
    over.cls ?? null,
    over.method ?? null,
    over.client ?? null,
    scope,
    over.limit ?? 500,
  ]).then((r) => r.rows as LRow[]);
const summary = (u: U, group: string, over: Partial<Record<string, unknown>> = {}) =>
  call(u, `select * from public.margin_summary($1, $2, $3, $4, $5, $6, $7)`, [
    group,
    over.from ?? null,
    over.to ?? null,
    over.plant ?? w.plantA,
    over.cls ?? null,
    over.method ?? null,
    over.client ?? null,
  ]).then((r) => r.rows as LRow[]);
const big = (v: unknown) => BigInt(String(v));

describe('T17 G9: the margin read doors', () => {
  let complete: { id: string; blNo: string; order: string };
  let goulotte: { id: string; blNo: string; order: string };
  let noJob: { id: string; blNo: string; order: string };
  let legacy: { id: string; blNo: string; order: string };
  let cancelledLoad: { id: string; blNo: string; order: string };

  beforeAll(async () => {
    await pumpJob(D1);
    complete = await loadOf(fxB25P, 8000, 'POMPE', D1);
    goulotte = await loadOf(fxB20G, 8000, 'GOULOTTE', D1);
    noJob = await loadOf(fxB25P, 4000, 'POMPE', D2); // no pump job on D2
    legacy = await loadOf(fxB20G, 2000, null, D1); // a legacy BL: no method recorded
    cancelledLoad = await loadOf(fxB20G, 3000, 'GOULOTTE', D1);
    const done = await cancelLoad(
      app,
      w.owner as unknown as SessionUser,
      { deliveryId: cancelledLoad.id, reason: 'fictitious cancel' },
      { today: D1 },
    );
    expect(done.ok).toBe(true);
  });

  it('every figure of a BL is the snapshot, the price is unit price x litres, and the three margins are the twin arithmetic', async () => {
    const rows = await list(w.owner, 'all');
    const row = rows.find((r) => r.o_bl_no === complete.blNo)!;
    expect(row).toMatchObject({
      o_method: 'POMPE',
      o_volume_l: '8000',
      o_is_reversal: false,
      o_incomplete: false,
      o_uses_assumption: true,
    });
    const price = salePriceCentimes(78_000n, 8_000n);
    expect(big(row.o_price_centimes)).toBe(price);
    // the blocks are the hand-checked ones of the T16 snapshot test (A1 data)
    expect(
      [
        row.o_materials_centimes,
        row.o_delivery_centimes,
        row.o_pump_centimes,
        row.o_plant_centimes,
        row.o_overheads_centimes,
        row.o_total_cost_centimes,
      ].map(big),
    ).toEqual([599_008n, 54_400n, 32_000n, 32_000n, 24_000n, 741_408n]);
    // the twin is fed with the INPUTS the snapshot froze (the rates and the norm of the day), not with its outputs
    const f = (
      await w.sup<Record<string, string>>(
        `select trip_fuel_ml::text tf, diesel_centimes_per_l::text dz, delivery_other_centimes_per_m3::text oth, pump_centimes_per_m3::text pm, plant_centimes_per_m3::text pl, overhead_centimes_per_m3::text ov
           from bl_cost_snapshot where delivery_id = $1`,
        [complete.id],
      )
    )[0]!;
    const twin = costBlocks({
      volumeL: 8000n,
      method: 'POMPE',
      materialsLines: [599_008n],
      perTripMl: big(f.tf),
      dieselCentimesPerL: big(f.dz),
      deliveryOtherPerM3: big(f.oth),
      pumpPerM3: big(f.pm),
      plantPerM3: big(f.pl),
      overheadPerM3: big(f.ov),
    });
    expect(twin.total).toBe(741_408n);
    const m = marginsOf(price, twin);
    expect([big(row.o_m1_centimes), big(row.o_m2_centimes), big(row.o_m3_centimes)]).toEqual([
      m.m1,
      m.m2,
      m.m3,
    ]);
    expect(m.m3).toBe(624_000n - 741_408n); // a negative margin is shown, not hidden
  });

  it('a cancelled load nets to zero: its reversing snapshot is a row of its own with the exact negation', async () => {
    // the reversing snapshot belongs to the reversing BL (a number of its own): find the pair by the litres
    const rows = (await list(w.owner, 'all')).filter(
      (r) => big(r.o_volume_l) === 3000n || big(r.o_volume_l) === -3000n,
    );
    expect(rows.find((r) => r.o_bl_no === cancelledLoad.blNo)).toBeTruthy();
    expect(rows).toHaveLength(2);
    const [a, b] = [rows.find((r) => !r.o_is_reversal)!, rows.find((r) => r.o_is_reversal)!];
    for (const k of [
      'o_price_centimes',
      'o_total_cost_centimes',
      'o_m1_centimes',
      'o_m2_centimes',
      'o_m3_centimes',
      'o_volume_l',
    ] as const)
      expect(big(a[k]) + big(b[k]), k).toBe(0n);
  });

  it('incomplete snapshots (no pump job, no method) are listed apart with their missing keys and are never summed with zero costs', async () => {
    const inc = await list(w.owner, 'incomplete');
    expect(inc.map((r) => r.o_bl_no).sort()).toEqual([noJob.blNo, legacy.blNo].sort());
    expect(inc.find((r) => r.o_bl_no === noJob.blNo)).toMatchObject({
      o_pump_centimes: '0',
      o_incomplete: true,
    });
    expect(inc.find((r) => r.o_bl_no === noJob.blNo)!.o_missing_keys).toContain('pump_job_missing');
    expect(inc.find((r) => r.o_bl_no === legacy.blNo)!.o_missing_keys).toContain('discharge_method');
    const completeRows = await list(w.owner, 'complete');
    expect(completeRows.some((r) => r.o_incomplete)).toBe(false);
    const sum = await summary(w.owner, 'method');
    const total = sum.find((r) => r.o_is_total)!;
    expect(big(total.o_incomplete_count)).toBe(2n);
    // the totals are the sums of the per-BL integers of the COMPLETE rows (reversals included), nothing more
    const add = (k: string) => completeRows.reduce((a, r) => a + big(r[k]), 0n);
    expect(big(total.o_price_centimes)).toBe(add('o_price_centimes'));
    expect(big(total.o_total_cost_centimes)).toBe(add('o_total_cost_centimes'));
    expect(big(total.o_m3_centimes)).toBe(add('o_m3_centimes'));
    expect(big(total.o_m1_centimes)).toBe(add('o_m1_centimes'));
    expect(big(total.o_m2_centimes)).toBe(add('o_m2_centimes'));
    expect(big(total.o_bl_count)).toBe(2n); // the POMPE load and the GOULOTTE load; the cancelled one nets out
    expect(big(total.o_m3_bp!)).toBe(marginBp(add('o_m3_centimes'), add('o_price_centimes')));
  });

  it('a BL with no method is a line of its own (NONE), never counted as GOULOTTE; the groupings add up to the same total', async () => {
    const byMethod = await summary(w.owner, 'method');
    expect(
      byMethod
        .filter((r) => !r.o_is_total)
        .map((r) => r.o_key)
        .sort(),
    ).toEqual(['GOULOTTE', 'NONE', 'POMPE']);
    const none = byMethod.find((r) => r.o_key === 'NONE')!;
    expect(big(none.o_bl_count)).toBe(0n); // its only BL is incomplete (no method): counted apart, not summed
    expect(big(none.o_incomplete_count)).toBe(1n);
    expect(big(none.o_price_centimes)).toBe(0n);
    const total = (g: string, k: string) =>
      summary(w.owner, g).then((r) => big(r.find((x) => x.o_is_total)![k]));
    for (const g of ['month', 'plant', 'class', 'client', 'class_method'])
      expect(await total(g, 'o_m3_centimes'), g).toBe(await total('method', 'o_m3_centimes'));
    // the method filter NONE returns the legacy line only
    expect((await list(w.owner, 'all', { method: 'NONE' })).map((r) => r.o_bl_no)).toEqual([legacy.blNo]);
  });

  it('the assumption banner counts the assumed inputs and the BLs that use them', async () => {
    const total = (await summary(w.owner, 'class')).find((r) => r.o_is_total)!;
    expect(big(total.o_assumed_inputs)).toBeGreaterThan(0n);
    expect(big(total.o_assumed_bl_count)).toBe(2n);
  });

  it('owner and app_admin read; every other role is refused (42501) on both doors, and the tables are closed to them', async () => {
    for (const u of [w.owner, w.appAdmin]) {
      expect((await list(u)).length, u.role).toBeGreaterThan(0);
      expect((await summary(u, 'month')).length, u.role).toBeGreaterThan(0);
    }
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA]) {
      expect(await code(() => list(u)), `${u.role} list`).toBe('42501');
      expect(await code(() => summary(u, 'month')), `${u.role} summary`).toBe('42501');
      for (const t of ['bl_cost_snapshot', 'bl_cost_snapshot_line', 'cost_rate', 'fuel_norm', 'price_grid'])
        expect(await code(() => call(u, `select 1 from public.${t} limit 1`)), `${u.role} ${t}`).toBe(
          '42501',
        );
    }
  });

  it('a bad filter or grouping is a business error (23514), and a request with no admitted actor is refused (42501) with nothing written', async () => {
    expect(await code(() => summary(w.owner, 'weekday'))).toBe('23514');
    expect(await code(() => summary(w.owner, 'method', { method: 'BETON' }))).toBe('23514');
    expect(await code(() => list(w.owner, 'some'))).toBe('23514');
    for (const sql of [
      `select * from public.bl_margin_list(null, null, null, null, null, null, 'all', 10)`,
      `select * from public.margin_summary('month', null, null, null, null, null, null)`,
    ]) {
      expect(
        await noActorOffenders(app, sql, [], { plantManager: w.pmA.id, driver: w.driverUserA.id }),
      ).toEqual([]);
    }
  });
});

describe('T17 G10: the pump check', () => {
  const P1 = '2026-02-12';
  const P2 = '2026-02-13';
  const P3 = '2026-02-14';
  const check = (u: U, plant: string | null = null, from = P1, to = P3) =>
    call(u, `select * from public.pump_check($1, $2, $3)`, [from, to, plant]).then((r) => r.rows as LRow[]);
  let a: { id: string; blNo: string };
  let c: { id: string; blNo: string };
  let bOnly: { id: string; blNo: string };
  let mismatch: { id: string; blNo: string };

  beforeAll(async () => {
    // plant A: (a) a POMPE BL with no job on P1; (b) a job with no POMPE BL on P2; (c) a GOULOTTE BL on P3 where a job exists for the same client
    a = await loadOf(fxB25P, 5000, 'POMPE', P1);
    await pumpJob(P2, w.plantA);
    c = await loadOf(fxB20G, 6000, 'GOULOTTE', P3);
    await pumpJob(P3, w.plantA);
    // not counted: a cancelled POMPE BL with no job, a BL with no method recorded
    const gone = await loadOf(fxB25P, 2000, 'POMPE', P1);
    const done = await cancelLoad(
      app,
      w.owner as unknown as SessionUser,
      { deliveryId: gone.id, reason: 'fictitious cancel' },
      { today: P1 },
    );
    expect(done.ok).toBe(true);
    await loadOf(fxB20G, 1000, null, P1);
    // plant B: its own POMPE BL with no job (the plant manager of A must never see it)
    bOnly = await loadOf(fxB25P, 7000, 'POMPE', P1, w.truckB, w.plantB);
    // a historical mismatch: a BL of an order of plant A whose own plant is B (the whole tuple is not plant A's)
    mismatch = await loadOf(fxB25P, 3000, 'POMPE', P1);
    await w.sup(`update delivery set plant_id = $2 where id = $1`, [mismatch.id, w.plantB], ['delivery']);
  });

  it('lists the three kinds per day and plant, for the owner; cancelled loads and loads with no method are not counted', async () => {
    const rows = await check(w.owner, w.plantA);
    const of = (k: string) => rows.filter((r) => r.o_kind === k);
    expect(of('pompe_bl_no_job').map((r) => r.o_bl_no)).toContain(a.blNo);
    expect(of('pompe_bl_no_job').every((r) => r.o_plant_id === w.plantA)).toBe(true);
    expect(of('job_no_pompe_bl')).toHaveLength(2); // the job of P2 and the job of P3: no POMPE BL on those days
    expect(of('goulotte_bl_with_job').map((r) => r.o_bl_no)).toEqual([c.blNo]);
    // the cancelled BL and the legacy one are in no list: the BLs of (a) are `a` and the mismatched one only
    expect(of('pompe_bl_no_job')).toHaveLength(2);
    const bothPlants = await check(w.owner, null);
    expect(bothPlants.some((r) => r.o_bl_no === bOnly.blNo && r.o_plant_id === w.plantB)).toBe(true);
    expect((await check(w.appAdmin, w.plantA)).length).toBe(rows.length);
  });

  it('a plant manager sees his own plant only, whatever plant he asks for, and never a BL whose own plant is another', async () => {
    const mine = await check(w.pmA);
    expect(mine.every((r) => r.o_plant_id === w.plantA)).toBe(true);
    expect(mine.map((r) => r.o_bl_no)).toContain(a.blNo);
    expect(mine.map((r) => r.o_bl_no)).not.toContain(bOnly.blNo);
    expect(mine.map((r) => r.o_bl_no)).not.toContain(mismatch.blNo);
    expect((await check(w.pmA, w.plantB)).map((r) => r.o_bl_no)).toEqual(mine.map((r) => r.o_bl_no));
    const theirs = await check(w.pmB);
    expect(theirs.map((r) => r.o_bl_no)).toContain(bOnly.blNo);
    expect(theirs.every((r) => r.o_plant_id === w.plantB)).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain(a.blNo);
  });

  it('every other role is refused (42501); a request with no admitted actor is refused with nothing written', async () => {
    for (const u of [w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(await code(() => check(u)), u.role).toBe('42501');
    expect(
      await noActorOffenders(app, `select * from public.pump_check('2026-02-12', '2026-02-14', null)`, [], {
        plantManager: w.pmA.id,
        driver: w.driverUserA.id,
      }),
    ).toEqual([]);
  });

  it('carries no cost figure, and a period over 93 days or reversed is a business error (23514)', async () => {
    const rows = await check(w.owner, w.plantA);
    expect(rows.length).toBeGreaterThan(0);
    for (const k of Object.keys(rows[0]!)) expect(k).not.toMatch(/cost|price|margin|centimes|amount/);
    expect(await code(() => check(w.owner, null, '2026-01-01', '2026-06-30'))).toBe('23514');
    expect(await code(() => check(w.owner, null, P3, P1))).toBe('23514');
  });

  it('the snapshot flag and the check use one definition of "a pump job": a POMPE BL is flagged pump_job_missing exactly when the check lists it', async () => {
    const served = await loadOf(fxB25P, 1000, 'POMPE', P2); // a job of the same client and plant exists on P2
    const flag = async (id: string) =>
      (
        await w.sup<{ k: string[] }>(`select missing_keys k from bl_cost_snapshot where delivery_id = $1`, [
          id,
        ])
      )[0]!.k.includes('pump_job_missing');
    const listed = (await check(w.owner, w.plantA))
      .filter((r) => r.o_kind === 'pompe_bl_no_job')
      .map((r) => r.o_bl_no);
    expect(await flag(a.id)).toBe(true);
    expect(listed).toContain(a.blNo);
    expect(await flag(served.id)).toBe(false);
    expect(listed).not.toContain(served.blNo);
  });
});

describe('T17 G11: the fuel check', () => {
  const J1 = '2026-01-01';
  const J2 = '2026-01-31';
  const check = (u: U, plant: string | null = null) =>
    call(u, `select * from public.fuel_check($1, $2, $3)`, [J1, J2, plant]).then((r) => r.rows as LRow[]);
  const fill = (truck: string, day: string, ml: number, plant = w.plantA) =>
    w.sup(
      `insert into fuel_fill (id, truck_id, filled_on, litres_ml, source, plant_id, created_by) values (gen_random_uuid(), $1, $2, $3, 'tank', $4, $5)`,
      [truck, day, ml, plant, w.owner.id],
    );
  const rowOf = async (u: U, truck: string) => (await check(u)).find((r) => r.o_truck_id === truck);

  beforeAll(async () => {
    // truck B (plant B): three loads in January, each with the mixer norm of the A1 seed (22 L per trip) frozen in its snapshot
    for (const day of ['2026-01-12', '2026-01-13', '2026-01-14'])
      await loadOf(fxB25P, 1000, 'GOULOTTE', day, w.truckB, w.plantB);
    await fill(w.truckB, '2026-01-10', 50_000, w.plantB);
    await fill(w.truckB, '2026-01-20', 30_000, w.plantB);
    // truck N (a hired truck): a norm of its own from 20 January only, so the load of the 12th has none
    await call(
      w.owner,
      `select public.set_fuel_norm(null, $1, 22000, null, null, '2026-01-20', 'fictitious norm', 'fictitious test norm')`,
      [w.truckN],
    );
    await loadOf(fxB25P, 1000, 'GOULOTTE', '2026-01-12', w.truckN, w.plantA);
    await loadOf(fxB25P, 1000, 'GOULOTTE', '2026-01-25', w.truckN, w.plantA);
    await fill(w.truckN, '2026-01-15', 60_000);
    // truck A: pumping hours, a per-hour norm of 30 L, one job pumping 2,5 hours on the 15th, 80 L filled
    await call(
      w.owner,
      `select public.set_fuel_norm(null, $1, null, 30000, null, '2026-01-01', 'fictitious norm', 'fictitious test norm')`,
      [w.truckA],
    );
    const job = (
      await w.sup<{ id: string }>(
        `insert into pump_job (id, job_date, pump_id, operator_id, client_id, site_label, plant_id, created_by) values (gen_random_uuid(), '2026-01-15', $1, $2, $3, 'chantier fictif', $4, $5) returning id`,
        [w.truckA, w.driverA, w.scene.clientId, w.plantA, w.owner.id],
      )
    )[0]!;
    for (const [step, at, m3] of [
      ['pumping_started', '2026-01-15T08:00:00Z', null],
      ['pumping_ended', '2026-01-15T10:30:00Z', 20],
    ] as const)
      await w.sup(
        `insert into pump_job_event (id, job_id, step, at, m3_pumped, client_key, created_by) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
        [job.id, step, at, m3, `${marker}-${step}`, w.owner.id],
      );
    await fill(w.truckA, '2026-01-16', 80_000);
  });

  it('expected litres are the frozen norm of each live trip; measured are the fills; the variance is in basis points of the expected, above the threshold it is flagged', async () => {
    const r = (await rowOf(w.owner, w.truckB))!;
    expect(r).toMatchObject({
      o_month: '2026-01',
      o_basis: 'trips',
      o_units: 3,
      o_no_norm_units: 0,
      o_fills: 2,
      o_expected_ml: '66000',
      o_measured_ml: '80000',
      o_variance_ml: '14000',
      o_variance_bp: 2121, // 14 000 / 66 000 = 21,21 %
      o_threshold_bp: 1000,
      o_threshold_assumption: true,
      o_flagged: true,
    });
    // the same integer arithmetic as the twin
    expect(mulDivRound(14_000n * 10_000n, 66_000n)).toBe(2121n);
  });

  it('a trip with no norm gives no variance and no flag (the expected figure would be a part); a pump is expected by its pumping hours', async () => {
    const n = (await rowOf(w.owner, w.truckN))!;
    expect(n).toMatchObject({
      o_units: 2,
      o_no_norm_units: 1,
      o_expected_ml: null,
      o_variance_ml: null,
      o_variance_bp: null,
      o_flagged: false,
      o_measured_ml: '60000',
    });
    const p = (await rowOf(w.owner, w.truckA))!;
    // 30 000 ml per hour x 9 000 s / 3 600 = 75 000 ml; 80 000 filled: +5 000 = 666 bp, under the 10 % threshold
    expect(p).toMatchObject({
      o_basis: 'hours',
      o_units: 1,
      o_expected_ml: '75000',
      o_measured_ml: '80000',
      o_variance_ml: '5000',
      o_variance_bp: 667,
      o_flagged: false,
    });
    expect(mulDivRound(5_000n * 10_000n, 75_000n)).toBe(667n);
  });

  it('the owner edits the threshold through set_cost_rate (a new row, no longer an assumption); a plant threshold wins over the all-plants one', async () => {
    await call(
      w.owner,
      `select public.set_cost_rate('fuel_variance_threshold_bp', 3000, '2026-01-02', $1, 'fictitious threshold', 'fictitious test threshold')`,
      [w.plantB],
    );
    const r = (await rowOf(w.owner, w.truckB))!;
    expect(r).toMatchObject({
      o_threshold_bp: 3000,
      o_threshold_assumption: false,
      o_flagged: false,
      o_variance_bp: 2121,
    });
    // a threshold is 1 to 10 000 bp and the unit follows the key
    expect(
      await code(() =>
        call(
          w.owner,
          `select public.set_cost_rate('fuel_variance_threshold_bp', 0, '2026-02-02', $1, 'fictitious', 'fictitious test')`,
          [w.plantB],
        ),
      ),
    ).toBe('23514');
    expect(
      await code(() =>
        call(
          w.owner,
          `select public.set_cost_rate('fuel_variance_threshold_bp', 20000, '2026-02-02', $1, 'fictitious', 'fictitious test')`,
          [w.plantB],
        ),
      ),
    ).toBe('23514');
    expect(
      (
        await w.sup<{ u: string }>(
          `select unit u from cost_rate where rate_key = 'fuel_variance_threshold_bp' and plant_id = $1`,
          [w.plantB],
        )
      )[0]!.u,
    ).toBe('bp');
    // every other role is refused on the threshold write too
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(
        await code(() =>
          call(
            u,
            `select public.set_cost_rate('fuel_variance_threshold_bp', 1500, '2026-03-02', null, 'fictitious', 'fictitious test')`,
          ),
        ),
        u.role,
      ).toBe('42501');
  });

  it('owner and app_admin read; every other role is refused (42501); no actor, nothing written; a bad period is 23514; the plant filter narrows', async () => {
    expect((await check(w.appAdmin)).length).toBeGreaterThan(0);
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(await code(() => check(u)), u.role).toBe('42501');
    expect(
      await noActorOffenders(app, `select * from public.fuel_check('2026-01-01', '2026-01-31', null)`, [], {
        plantManager: w.pmA.id,
        driver: w.driverUserA.id,
      }),
    ).toEqual([]);
    expect(
      await code(() => call(w.owner, `select * from public.fuel_check('2026-01-01', '2027-12-31', null)`)),
    ).toBe('23514');
    expect(
      (await check(w.owner, w.plantB)).every((r) => r.o_plant_code !== null && r.o_truck_id === w.truckB),
    ).toBe(true);
  });
});
