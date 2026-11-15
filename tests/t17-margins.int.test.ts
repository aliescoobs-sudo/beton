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
) {
  const master = { ...base, typeId: fx.typeId, sellingPriceId: fx.priceId, clientId: w.scene.clientId };
  const o = await w.asOwnerIn(w.plantA, (tx) =>
    insertOrder(tx, w.owner.id, master, '2026-06-02', null, method),
  );
  const d = await w.asOwnerIn(w.plantA, (tx) =>
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
const pumpJob = (day: string, client: string | null = w.scene.clientId, pump = w.truckA) =>
  w.sup(
    `insert into pump_job (id, job_date, pump_id, operator_id, client_id, site_label, created_by) values (gen_random_uuid(), $1, $2, $3, $4, 'chantier fictif', $5)`,
    [day, pump, w.driverA, client, w.owner.id],
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
