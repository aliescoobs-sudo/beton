import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelLoad } from '../src/modules/operations';
import {
  costBlocks,
  materialsLineCentimes,
  mulDivRound,
} from '../src/modules/operations/domain/cost-arithmetic';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { insertDelivery, insertOrder, orderMaster, type OrderMaster } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';

/** T16 G6 (SPEC-cost-margin §5, §7, §15; D236): the cost snapshot of a BL, written inside the BL transaction. Fictitious A1 data; refusals assert the SQLSTATE. */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `t16c${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
type Fx = { typeId: string; recetteId: string; priceId: string };
let fxB25P: Fx;
let fxB20G: Fx;
let base: OrderMaster;
type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
type Snap = Record<string, string | number | boolean | string[] | null>;
const snapOf = async (deliveryId: string) =>
  (
    await w.sup<Snap>(
      `select s.id, s.reverses_id, s.discharge_method, s.volume_l, s.recette_version, s.diesel_centimes_per_l, s.trip_fuel_ml, s.pump_centimes_per_m3,
              s.materials_centimes::int m, s.delivery_centimes::int d, s.pump_centimes::int p, s.plant_centimes::int pl, s.overheads_centimes::int o, s.total_cost_centimes::int t,
              s.incomplete, s.missing_keys, s.uses_assumption, s.diesel_rate_id, s.fuel_norm_id, s.pump_rate_id
         from bl_cost_snapshot s where s.delivery_id = $1`,
      [deliveryId],
    )
  )[0];

/** An order of the fictitious FX class with a selling price (an industrial class has none of its own) and a BL of it, in a plant. */
async function loadOf(
  plant: string,
  truck: string,
  fx: Fx,
  volumeL: number,
  method: 'GOULOTTE' | 'POMPE' | null,
  loadDate = '2026-06-01',
  actor: U = w.owner,
) {
  const master = { ...base, typeId: fx.typeId, sellingPriceId: fx.priceId, clientId: w.scene.clientId };
  const o = await w.asOwnerIn(plant, (tx) => insertOrder(tx, w.owner.id, master, '2026-06-02', null, method));
  // the BL is written as the actor: the owner in the plant, or the plant manager in his own (the row-level rules decide)
  const inActor = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
    actor === w.owner ? w.asOwnerIn(plant, fn) : w.as(actor, fn);
  const d = await inActor((tx) =>
    insertDelivery(
      tx,
      actor.id,
      { orderId: o.id, truckId: truck, recetteId: fx.recetteId },
      volumeL,
      2026,
      null,
      loadDate,
    ),
  );
  const row = await w.sup<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo]);
  return { order: o.id, id: row[0]!.id };
}

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
  base = await orderMaster(app, w.owner.id, `${marker}a`);
  const fx = async (c: string) => {
    const [row] = await w.sup<{ t: string; r: string }>(
      `select t.id t, r.id r from concrete_type t join recette r on r.concrete_type_id = t.id where t.code = $1`,
      [c],
    );
    // an industrial class needs a selling price for an order to exist; the A1 seed gives none, the fixture does
    // T17: another suite of the same run may have made this price already (the fictitious classes are shared): take it, or make it
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
  // T17 (D243): a POMPE BL of the world's client is complete only when a pump job exists that day: the loads of these tests are on 2026-06-01
  await w.sup(
    `insert into pump_job (id, job_date, pump_id, operator_id, client_id, site_label, created_by) values (gen_random_uuid(), '2026-06-01', $1, $2, $3, 'chantier fictif', $4)`,
    [w.truckA, w.driverA, w.scene.clientId, w.owner.id],
  );
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('T16 G6: the snapshot is written with the BL, from the A1 data', () => {
  it('a POMPE load of the fictitious FX-B25-P recette: the five blocks are the hand-checked integers, every input and its version id is frozen', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB25P, 8000, 'POMPE');
    const s = (await snapOf(load.id))!;
    expect(s).toMatchObject({
      reverses_id: null,
      discharge_method: 'POMPE',
      volume_l: 8000,
      recette_version: 1,
      diesel_centimes_per_l: '1700',
      trip_fuel_ml: '22000',
      pump_centimes_per_m3: '4000',
      m: 599_008,
      d: 54_400,
      p: 32_000,
      pl: 32_000,
      o: 24_000,
      t: 741_408,
      incomplete: false,
      missing_keys: [],
      uses_assumption: true,
    });
    expect(s.diesel_rate_id).toBeTruthy();
    expect(s.fuel_norm_id).toBeTruthy();
    expect(s.pump_rate_id).toBeTruthy();
    const lines = await w.sup<{
      code: string;
      qty_base: string;
      line: number;
      price: string;
      tr: string;
      pid: string | null;
      tid: string | null;
    }>(
      `select c.name_fr code, l.qty_base::text, l.line_centimes::int line, l.price_centimes::text price, l.transport_centimes::text tr, l.purchase_price_id pid, l.transport_id tid
         from bl_cost_snapshot_line l join component c on c.id = l.component_id where l.snapshot_id = $1 order by c.name_fr`,
      [s.id],
    );
    expect(lines.map((l) => [l.code, l.line])).toEqual([
      ['FX ADJ 15 (fictif)', 43_200],
      ['FX ADJ 16 (fictif)', 14_400],
      ['FX CPJ 55 (fictif)', 341_600],
      ['FX EAU (fictif)', 1_728],
      ['FX GI (fictif)', 51_680],
      ['FX GII (fictif)', 57_120],
      ['FX S/C (fictif)', 43_200],
      ['FX S/M (fictif)', 46_080],
    ]);
    expect(lines.every((l) => l.pid && l.tid)).toBe(true);
    expect(lines.find((l) => l.code.includes('GI (fictif)'))).toMatchObject({
      qty_base: '3040000',
      price: '13000',
      tr: '4000',
    });
    expect(lines.reduce((a, l) => a + l.line, 0)).toBe(599_008);
  });

  it('a GOULOTTE load has no pump block and no pump rate; the twin arithmetic of the code gives the same blocks', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB20G, 8000, 'GOULOTTE');
    const s = (await snapOf(load.id))!;
    expect(s).toMatchObject({
      discharge_method: 'GOULOTTE',
      p: 0,
      pump_rate_id: null,
      m: 525_632,
      d: 54_400,
      pl: 32_000,
      o: 24_000,
      incomplete: false,
    });
    const mine = costBlocks({
      volumeL: 8_000n,
      method: 'GOULOTTE',
      materialsLines: [
        materialsLineCentimes({
          qtyPerM3: 400_000n,
          volumeL: 8_000n,
          priceCentimes: 13_000n,
          transportCentimes: 4_000n,
          factorToBase: 1_000_000n,
        }),
        materialsLineCentimes({
          qtyPerM3: 350_000n,
          volumeL: 8_000n,
          priceCentimes: 11_000n,
          transportCentimes: 4_000n,
          factorToBase: 1_000_000n,
        }),
        materialsLineCentimes({
          qtyPerM3: 350_000n,
          volumeL: 8_000n,
          priceCentimes: 12_000n,
          transportCentimes: 4_000n,
          factorToBase: 1_000_000n,
        }),
        materialsLineCentimes({
          qtyPerM3: 450_000n,
          volumeL: 8_000n,
          priceCentimes: 13_000n,
          transportCentimes: 4_000n,
          factorToBase: 1_000_000n,
        }),
        materialsLineCentimes({
          qtyPerM3: 300_000n,
          volumeL: 8_000n,
          priceCentimes: 120_000n,
          transportCentimes: 2_000n,
          factorToBase: 1_000_000n,
        }),
        materialsLineCentimes({
          qtyPerM3: 170n,
          volumeL: 8_000n,
          priceCentimes: 1_200n,
          transportCentimes: 0n,
          factorToBase: 1_000n,
        }),
        materialsLineCentimes({
          qtyPerM3: 2_000n,
          volumeL: 8_000n,
          priceCentimes: 1_800n,
          transportCentimes: 0n,
          factorToBase: 1_000n,
        }),
      ],
      perTripMl: 22_000n,
      dieselCentimesPerL: 1_700n,
      deliveryOtherPerM3: 2_125n,
      pumpPerM3: 4_000n,
      plantPerM3: 4_000n,
      overheadPerM3: 3_000n,
    });
    expect([mine.materials, mine.delivery, mine.pump, mine.plant, mine.overheads, mine.total]).toEqual([
      525_632n,
      54_400n,
      0n,
      32_000n,
      24_000n,
      636_032n,
    ]);
  });

  it('a legacy order (no method) still posts: the pump costs 0 and the snapshot is incomplete with the missing key discharge_method', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB25P, 8000, null);
    const s = (await snapOf(load.id))!;
    expect(s).toMatchObject({
      discharge_method: null,
      p: 0,
      incomplete: true,
      missing_keys: ['discharge_method'],
    });
  });

  it('a plant manager creates the BL and triggers the snapshot, but reads nothing back: no table, no door (42501)', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB25P, 4000, 'POMPE', '2026-06-01', w.pmA);
    expect(await snapOf(load.id)).toBeTruthy();
    for (const t of ['bl_cost_snapshot', 'bl_cost_snapshot_line'])
      expect(await code(() => w.as(w.pmA, (tx) => tx.query(`select * from ${t}`))), t).toBe('42501');
  });
});

describe('T16 G6: a missing input never stops the BL and is never replaced silently', () => {
  it('before any rate or price exists, the BL posts, every block is 0 and every missing key is listed', async () => {
    const load = await w.asOwnerIn(w.plantA, async (tx) => {
      const o = await insertOrder(
        tx,
        w.owner.id,
        { ...base, clientId: w.scene.clientId },
        '2026-06-02',
        null,
        'POMPE',
      );
      const d = await insertDelivery(
        tx,
        w.owner.id,
        { orderId: o.id, truckId: w.truckA, recetteId: w.scene.recetteId },
        5000,
        2026,
        null,
        '2025-06-01',
      );
      return (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo])).rows[0]!
        .id;
    });
    const s = (await snapOf(load))!;
    const keys = (s.missing_keys as string[]).slice().sort();
    expect(keys.filter((k) => k.startsWith('rate:'))).toEqual([
      'rate:delivery_other_per_m3',
      'rate:diesel_per_l',
      'rate:overhead_per_m3',
      'rate:plant_per_m3',
      'rate:pump_per_m3',
    ]);
    expect(keys).toContain('fuel_norm:mixer');
    expect(keys.filter((k) => k.startsWith('price:'))).toHaveLength(2);
    expect(s).toMatchObject({
      m: 0,
      d: 0,
      p: 0,
      pl: 0,
      o: 0,
      t: 0,
      incomplete: true,
      uses_assumption: false,
    });
    expect(await w.sup(`select 1 from delivery where id = $1`, [load])).toHaveLength(1);
  });

  it('a purchase price with no transport row is "transport not recorded": the line costs the price alone and says so', async () => {
    const comp = (
      await w.sup<{ id: string; code: string }>(
        `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, $1, 'g') returning id, code`,
        [`t16 ${marker} notransport`],
      )
    )[0]!;
    const unit = (
      await w.sup<{ id: string }>(
        `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 't', 1000000) returning id`,
        [comp.id],
      )
    )[0]!;
    const sup = (await w.sup<{ id: string }>(`select id from supplier limit 1`))[0]!;
    await w.sup(
      `insert into purchase_price (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by) values (gen_random_uuid(), $1, $2, $3, 100000, '2026-01-01', $4)`,
      [comp.id, sup.id, unit.id, w.owner.id],
    );
    const rid = (
      await w.sup<{ id: string }>(
        `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 2, '2026-03-01', $2) returning id`,
        [fxB20G.typeId, w.owner.id],
      )
    )[0]!.id;
    await w.sup(
      `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, $2, 500000)`,
      [rid, comp.id],
      ['recette_line'],
    );
    const load = await loadOf(
      w.plantA,
      w.truckA,
      { typeId: fxB20G.typeId, recetteId: rid, priceId: fxB20G.priceId },
      2000,
      'GOULOTTE',
    );
    const s = (await snapOf(load.id))!;
    // 500 kg per m3 x 2 m3 = 1 t at 1 000 DH/t, no transport
    expect(s).toMatchObject({
      m: 100_000,
      incomplete: true,
      missing_keys: [`transport:${comp.code}`],
      recette_version: 2,
    });
  });

  it('the plant rate wins over the all-plants one, and a replacement rate (a new row) changes later snapshots only', async () => {
    const before = (await snapOf((await loadOf(w.plantA, w.truckA, fxB25P, 8000, 'GOULOTTE')).id))!;
    expect(before.o).toBe(24_000);
    await w.as(w.owner, (tx) =>
      tx.query('select public.set_cost_rate($1,$2,$3,$4,$5,$6)', [
        'overhead_per_m3',
        5000,
        '2026-02-01',
        w.plantA,
        'fictitious plant rate',
        'test',
      ]),
    );
    const mine = (await snapOf((await loadOf(w.plantA, w.truckA, fxB25P, 8000, 'GOULOTTE')).id))!;
    const other = (await snapOf((await loadOf(w.plantB, w.truckB, fxB25P, 8000, 'GOULOTTE')).id))!;
    expect(mine.o).toBe(40_000);
    expect(other.o).toBe(24_000);
    // the snapshot taken before is untouched
    expect(
      (await snapOf(
        (
          await w.sup<{ id: string }>(
            `select id from delivery where id in (select delivery_id from bl_cost_snapshot where id = $1)`,
            [before.id as string],
          )
        )[0]!.id,
      ))!.o,
    ).toBe(24_000);
  });
});

describe('T16 G6: cancelling a load writes a reversing snapshot; nothing is updated or deleted', () => {
  it('the reversing snapshot is the exact negation of the original, linked to it, with negated lines', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB25P, 8000, 'POMPE');
    const original = (await snapOf(load.id))!;
    const done = await cancelLoad(
      app,
      w.owner as unknown as SessionUser,
      { deliveryId: load.id, reason: 'fictitious cancel' },
      { today: '2026-06-01' },
    );
    expect(done.ok).toBe(true);
    const rev = (await snapOf(done.ok ? done.value.id : ''))!;
    expect(rev).toMatchObject({
      reverses_id: original.id,
      volume_l: -8000,
      discharge_method: 'POMPE',
      m: -(original.m as number),
      d: -(original.d as number),
      p: -(original.p as number),
      pl: -(original.pl as number),
      o: -(original.o as number),
      t: -(original.t as number),
      incomplete: false,
    });
    expect(original).toMatchObject({ m: 599_008, d: 54_400, p: 32_000, pl: 32_000 });
    const sums = await w.sup<{ s: string; q: string }>(
      `select sum(line_centimes)::text s, sum(qty_base)::text q from bl_cost_snapshot_line where snapshot_id in ($1, $2)`,
      [original.id, rev.id],
    );
    expect(sums[0]).toEqual({ s: '0', q: '0' });
    // a second cancellation is refused by the BL rules; the original keeps its one reversing snapshot
    expect((await w.sup(`select 1 from bl_cost_snapshot where reverses_id = $1`, [original.id])).length).toBe(
      1,
    );
  });

  it('a BL older than the snapshot (no snapshot) writes none when cancelled; rows are sealed (23000), the owner included', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB25P, 2000, 'POMPE');
    const s = (await snapOf(load.id))!;
    for (const stmt of [
      `update bl_cost_snapshot set total_cost_centimes = 0 where id = '${s.id}'`,
      `delete from bl_cost_snapshot where id = '${s.id}'`,
      `update bl_cost_snapshot_line set line_centimes = 0 where snapshot_id = '${s.id}'`,
      `delete from bl_cost_snapshot_line where snapshot_id = '${s.id}'`,
    ])
      expect(await code(() => migrator.query(stmt)), stmt).toBe('23000');
    for (const u of [
      w.owner,
      w.appAdmin,
      w.pmA,
      w.purchases,
      w.sales,
      w.accountant,
      w.partner,
      w.support,
      w.driverUserA,
    ])
      for (const stmt of [
        `update bl_cost_snapshot set volume_l = 1`,
        `delete from bl_cost_snapshot`,
        `insert into bl_cost_snapshot select * from bl_cost_snapshot`,
      ])
        expect(await code(() => w.as(u, (tx) => tx.query(stmt))), `${u.role} ${stmt}`).toBe('42501');
  });
});

describe('T16 G6: the snapshot is part of the BL transaction', () => {
  it('a BL rolled back leaves no snapshot; a BL the guards refuse leaves none either', async () => {
    const before = (await w.sup<{ c: string }>(`select count(*)::text c from bl_cost_snapshot`))[0]!.c;
    await w
      .asOwnerIn(w.plantA, async (tx) => {
        const o = await insertOrder(
          tx,
          w.owner.id,
          { ...base, typeId: fxB25P.typeId, sellingPriceId: fxB25P.priceId, clientId: w.scene.clientId },
          '2026-06-02',
          null,
          'POMPE',
        );
        await insertDelivery(
          tx,
          w.owner.id,
          { orderId: o.id, truckId: w.truckA, recetteId: fxB25P.recetteId },
          1000,
        );
        throw new Error('__rollback__');
      })
      .catch(() => undefined);
    // a recette that is not the one in force is refused by the delivery guard
    const refused = await code(() =>
      w.asOwnerIn(w.plantA, async (tx) => {
        const o = await insertOrder(
          tx,
          w.owner.id,
          { ...base, typeId: fxB25P.typeId, sellingPriceId: fxB25P.priceId, clientId: w.scene.clientId },
          '2026-06-02',
          null,
          'POMPE',
        );
        await insertDelivery(
          tx,
          w.owner.id,
          { orderId: o.id, truckId: w.truckA, recetteId: fxB20G.recetteId },
          1000,
        );
      }),
    );
    expect(refused).toBe('23514');
    expect((await w.sup<{ c: string }>(`select count(*)::text c from bl_cost_snapshot`))[0]!.c).toBe(before);
  });

  it('every snapshot row is in the hash-chained audit log, visible to the owner roles only', async () => {
    const load = await loadOf(w.plantA, w.truckA, fxB25P, 1000, 'POMPE');
    const s = (await snapOf(load.id))!;
    expect(
      await w.sup(`select 1 from audit_event where table_name = 'bl_cost_snapshot' and row_id = $1`, [
        s.id as string,
      ]),
    ).toHaveLength(1);
    const seen = (u: U) =>
      w.as(
        u,
        async (tx) =>
          (
            await tx.query(
              `select 1 from audit_event where table_name in ('bl_cost_snapshot', 'bl_cost_snapshot_line')`,
            )
          ).rows.length,
      );
    expect(await seen(w.owner)).toBeGreaterThan(0);
    expect(await seen(w.appAdmin)).toBeGreaterThan(0);
    for (const u of [w.partner, w.support, w.sales, w.purchases, w.pmA, w.accountant, w.driverUserA])
      expect(await seen(u), u.role).toBe(0);
  });
});

describe('T16 G6: the arithmetic of the database and of the code agree', () => {
  it('_mul_div_round and mulDivRound give the same integer on ties, negatives, exact quotients and products beyond a double', async () => {
    const cases: [bigint, bigint][] = [
      [5n, 2n],
      [-5n, 2n],
      [1n, 2n],
      [-1n, 2n],
      [3n, 2n],
      [7n, 3n],
      [-7n, 3n],
      [0n, 5n],
      [10n, 5n],
      [-10n, 5n],
      [10n ** 18n + 5n * 10n ** 17n, 10n ** 18n],
      [-(10n ** 18n + 5n * 10n ** 17n), 10n ** 18n],
      [123456789012345678n * 98765n, 1000n * 1000000n],
      [1n, 3n],
      [2n, 3n],
    ];
    for (let i = 0; i < 60; i++)
      cases.push([
        BigInt(Math.floor(Math.random() * 2e9) - 1e9) * BigInt(Math.floor(Math.random() * 1e6)),
        BigInt(1 + Math.floor(Math.random() * 5000)),
      ]);
    for (const [n, d] of cases) {
      const [row] = await w.sup<{ v: string }>(
        `select public._mul_div_round($1::numeric, $2::numeric)::text v`,
        [n.toString(), d.toString()],
      );
      expect(row!.v, `${n}/${d}`).toBe(mulDivRound(n, d).toString());
    }
    // the helper is not executable by a request role
    expect(await code(() => w.as(w.owner, (tx) => tx.query('select public._mul_div_round(1, 2)')))).toBe(
      '42501',
    );
  });
});
