import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security';
import { testEnv } from './db-env';
import { noActorOffenders } from './helpers/no-actor-sweep';
import { plantWorld, type World } from './helpers/plant-world';

/** T16 G5 (SPEC-cost-margin §5, §8, §11; D236, D237): cost rates, fuel norms, delivered transport, and the A1 seed. Fictitious data only; refusals assert the SQLSTATE. */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `t16b${randomUUID().replace(/-/g, '').slice(0, 10)}`;
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
const others = () => [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA];
const real = () => ({ plantManager: w.pmA.id, driver: w.driverUserA.id });
let seq = 0;
/** A future year per call so versions in the shared database always go forward (no date is ever reused). */
const year = () => 2200 + seq++;

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('T16 G5: cost rates', () => {
  const rate = (
    u: U,
    key: string,
    value: number,
    from: string,
    plant: string | null = null,
    note = 'fictitious source',
    reason = 'fictitious',
  ) =>
    call(u, 'select public.set_cost_rate($1,$2,$3,$4,$5,$6) as r', [key, value, from, plant, note, reason]);

  it('owner and app_admin write a version: the unit follows the key, it is never flagged as an assumption, the audit chain records it', async () => {
    const id = (await rate(w.owner, 'plant_per_m3', 4100, `${year()}-01-01`)).rows[0]!.r as string;
    const [row] = await w.sup<{ unit: string; a: boolean; v: string }>(
      `select unit, is_assumption a, value_centimes::text v from cost_rate where id = $1`,
      [id],
    );
    expect(row).toEqual({ unit: 'centimes_per_m3', a: false, v: '4100' });
    const d = (await rate(w.appAdmin, 'diesel_per_l', 1750, `${year()}-01-01`)).rows[0]!.r as string;
    expect((await w.sup(`select unit from cost_rate where id = $1`, [d]))[0]!.unit).toBe('centimes_per_l');
    expect(
      await w.sup(
        `select 1 from audit_event where table_name = 'cost_rate' and row_id = $1 and actor_user_id = $2`,
        [id, w.owner.id],
      ),
    ).toHaveLength(1);
  });

  it('every other role is refused (42501), nothing is written', async () => {
    const before = (await w.sup<{ c: string }>(`select count(*)::text c from cost_rate`))[0]!.c;
    for (const u of others())
      expect(await code(() => rate(u, 'plant_per_m3', 1, `${year()}-01-01`)), u.role).toBe('42501');
    expect((await w.sup<{ c: string }>(`select count(*)::text c from cost_rate`))[0]!.c).toBe(before);
  });

  it('versions go forward; bad key, negative value, short note or reason, unknown plant are refused (23514)', async () => {
    const y = year();
    await rate(w.owner, 'overhead_per_m3', 3000, `${y}-03-01`);
    expect(await code(() => rate(w.owner, 'overhead_per_m3', 3100, `${y}-03-01`))).toBe('23514');
    expect(await code(() => rate(w.owner, 'overhead_per_m3', 3100, `${y}-02-01`))).toBe('23514');
    await rate(w.owner, 'overhead_per_m3', 3100, `${y}-04-01`);
    expect(await code(() => rate(w.owner, 'tea_per_m3', 1, `${year()}-01-01`))).toBe('23514');
    expect(await code(() => rate(w.owner, 'plant_per_m3', -1, `${year()}-01-01`))).toBe('23514');
    expect(await code(() => rate(w.owner, 'plant_per_m3', 1, `${year()}-01-01`, null, 'no'))).toBe('23514');
    expect(
      await code(() => rate(w.owner, 'plant_per_m3', 1, `${year()}-01-01`, null, 'fictitious', ' ')),
    ).toBe('23514');
    expect(await code(() => rate(w.owner, 'plant_per_m3', 1, `${year()}-01-01`, randomUUID()))).toBe('23514');
    // a plant has its own line of versions
    expect(await code(() => rate(w.owner, 'overhead_per_m3', 2900, `${y}-03-15`, w.plantA))).toBeUndefined();
  });
});

describe('T16 G5: fuel norms', () => {
  const norm = (
    u: U,
    kind: string | null,
    truck: string | null,
    trip: number | null,
    hour: number | null,
    km: number | null,
    from: string,
  ) =>
    call(u, 'select public.set_fuel_norm($1,$2,$3,$4,$5,$6,$7,$8) as r', [
      kind,
      truck,
      trip,
      hour,
      km,
      from,
      'fictitious source',
      'fictitious',
    ]);

  it('a norm belongs to a truck kind or to ONE truck, has at least one figure (millilitres), goes forward in time', async () => {
    const y = year();
    await norm(w.owner, 'hauler', null, 30_000, null, null, `${y}-01-01`);
    await norm(w.appAdmin, null, w.truckA, null, 9_000, 730, `${y}-01-01`);
    expect(await code(() => norm(w.owner, 'hauler', null, 31_000, null, null, `${y}-01-01`))).toBe('23514');
    expect(await code(() => norm(w.owner, 'hauler', w.truckA, 1, null, null, `${year()}-01-01`))).toBe(
      '23514',
    );
    expect(await code(() => norm(w.owner, null, null, 1, null, null, `${year()}-01-01`))).toBe('23514');
    expect(await code(() => norm(w.owner, 'hauler', null, null, null, null, `${year()}-01-01`))).toBe(
      '23514',
    );
    expect(await code(() => norm(w.owner, 'hauler', null, 0, null, null, `${year()}-01-01`))).toBe('23514');
    expect(await code(() => norm(w.owner, 'tractor', null, 5, null, null, `${year()}-01-01`))).toBe('23514');
    expect(await code(() => norm(w.owner, null, randomUUID(), 5, null, null, `${year()}-01-01`))).toBe(
      '23514',
    );
  });

  it('every other role is refused (42501)', async () => {
    for (const u of others())
      expect(await code(() => norm(u, 'hauler', null, 5, null, null, `${year()}-01-01`)), u.role).toBe(
        '42501',
      );
  });
});

describe('T16 G5: the delivered price (purchase price + transport)', () => {
  it('a transport is a separate doors-only row; the latest one wins in the list; a price with none is "not recorded"', async () => {
    const [price] = await w.sup<{ id: string }>(
      `select p.id from purchase_price p order by p.created_at desc limit 1`,
    );
    const set = (u: U, v: number) =>
      call(u, 'select public.set_purchase_price_transport($1,$2,$3,$4) as r', [
        price!.id,
        v,
        'fictitious invoice',
        'fictitious',
      ]);
    await set(w.owner, 1000);
    await set(w.appAdmin, 1500);
    const list = (await call(w.owner, 'select * from public.purchase_transports_list()')).rows;
    expect(list.find((r) => r.o_price_id === price!.id)?.o_transport_centimes).toBe('1500');
    expect(list.find((r) => r.o_price_id === price!.id)?.o_transport_is_assumption).toBe(false);
    expect(await code(() => set(w.owner, -1))).toBe('23514');
    expect(
      await code(() =>
        call(w.owner, 'select public.set_purchase_price_transport($1,1,$2,$3)', [
          randomUUID(),
          'fictitious',
          'fictitious',
        ]),
      ),
    ).toBe('23514');
    for (const u of others()) expect(await code(() => set(u, 5)), u.role).toBe('42501');
    // the purchasing office still reads purchase_price but never a transport
    expect(await code(() => call(w.purchases, 'select * from public.purchase_transports_list()'))).toBe(
      '42501',
    );
    expect(
      await code(() => call(w.purchases, 'select transport_centimes from purchase_price_transport')),
    ).toBe('42501');
  });
});

describe('T16 G5: visibility and refusals for EVERY role on every cost table and door', () => {
  const doors: [string, string][] = [
    ['cost_rates_list', 'select * from public.cost_rates_list()'],
    ['fuel_norms_list', 'select * from public.fuel_norms_list()'],
    ['purchase_transports_list', 'select * from public.purchase_transports_list()'],
  ];
  it('the list doors answer the owner roles and refuse everybody else (42501)', async () => {
    for (const [name, sql] of doors) {
      expect(await code(() => call(w.owner, sql)), name).toBeUndefined();
      expect(await code(() => call(w.appAdmin, sql)), name).toBeUndefined();
      for (const u of others()) expect(await code(() => call(u, sql)), `${name} ${u.role}`).toBe('42501');
    }
  });

  it('no role reads, writes, updates or deletes a cost table directly (42501), the owner included; the audit rows are the owner roles only', async () => {
    for (const t of ['cost_rate', 'fuel_norm', 'purchase_price_transport']) {
      for (const u of [w.owner, w.appAdmin, ...others()]) {
        expect(await code(() => call(u, `select * from ${t}`)), `${u.role} select ${t}`).toBe('42501');
        expect(await code(() => call(u, `update ${t} set reason = 'x'`)), `${u.role} update ${t}`).toBe(
          '42501',
        );
        expect(await code(() => call(u, `delete from ${t}`)), `${u.role} delete ${t}`).toBe('42501');
        expect(
          await code(() => call(u, `insert into ${t} select * from ${t}`)),
          `${u.role} insert ${t}`,
        ).toBe('42501');
      }
      expect(await code(() => migrator.query(`delete from ${t}`))).toBe('23000');
      expect(await code(() => migrator.query(`update ${t} set reason = 'x'`))).toBe('23000');
    }
    const audit = (u: U) =>
      w.as(
        u,
        async (tx) =>
          (
            await tx.query(
              `select 1 from audit_event where table_name in ('cost_rate', 'fuel_norm', 'purchase_price_transport')`,
            )
          ).rows.length,
      );
    expect(await audit(w.owner)).toBeGreaterThan(0);
    expect(await audit(w.appAdmin)).toBeGreaterThan(0);
    for (const u of [w.partner, w.support, w.sales, w.purchases, w.pmA, w.accountant, w.driverUserA])
      expect(await audit(u), u.role).toBe(0);
  });

  it('every door refuses each context that is not an admitted actor, with real targets, and writes nothing', async () => {
    const [price] = await w.sup<{ id: string }>(`select id from purchase_price limit 1`);
    const y = year();
    const calls: [string, unknown[]][] = [
      [
        'select public.set_cost_rate($1,$2,$3,$4,$5,$6)',
        ['plant_per_m3', 1, `${y}-01-01`, w.plantA, 'sweep', 'sweep'],
      ],
      [
        'select public.set_fuel_norm($1,$2,$3,$4,$5,$6,$7,$8)',
        [null, w.truckA, 1, null, null, `${y}-01-01`, 'sweep', 'sweep'],
      ],
      ['select public.set_purchase_price_transport($1,$2,$3,$4)', [price!.id, 1, 'sweep', 'sweep']],
      ['select * from public.cost_rates_list()', []],
      ['select * from public.fuel_norms_list()', []],
      ['select * from public.purchase_transports_list()', []],
    ];
    for (const [sql, params] of calls)
      expect(await noActorOffenders(app, sql, params, real()), sql).toEqual([]);
    expect(await w.sup(`select 1 from cost_rate where effective_from = $1`, [`${y}-01-01`])).toHaveLength(0);
  });
});

describe('T16 G5: the A1 seed is data, flagged as an assumption, and nothing else', () => {
  it('every seeded cost, norm, grid, mapping and transport row is flagged is_assumption', async () => {
    for (const t of [
      'cost_rate',
      'fuel_norm',
      'price_grid',
      'class_method_recette',
      'purchase_price_transport',
    ]) {
      const rows = await w.sup<{ total: string; flagged: string }>(
        `select count(*)::text total, count(*) filter (where is_assumption)::text flagged from ${t} where created_by = $1`,
        [SYSTEM_ACTOR_ID],
      );
      expect(Number(rows[0]!.total), t).toBeGreaterThan(0);
      expect(rows[0]!.flagged, t).toBe(rows[0]!.total);
    }
  });

  it('holds the A1 values: grid GOULOTTE B10..B35 and POMPE = GOULOTTE + 50 DH, the rates, the mixer norm of 22 L per trip', async () => {
    const grid = await w.sup<{ code: string; m: string; p: string }>(
      `select t.code, g.discharge_method m, g.price_ht_per_m3_centimes::text p from price_grid g join concrete_type t on t.id = g.concrete_type_id
        where g.created_by = $1 and t.code in ('B10','B15','B20','B25','B30','B35') order by t.code, g.discharge_method`,
      [SYSTEM_ACTOR_ID],
    );
    const goulotte = { B10: 600, B15: 660, B20: 740, B25: 820, B30: 890, B35: 930 } as const;
    expect(grid.map((g) => [g.code, g.m, Number(g.p)])).toEqual(
      Object.entries(goulotte).flatMap(([c, v]) => [
        [c, 'GOULOTTE', v * 100],
        [c, 'POMPE', (v + 50) * 100],
      ]),
    );
    const rates = await w.sup<{ k: string; v: string }>(
      `select rate_key k, value_centimes::text v from cost_rate where created_by = $1 order by rate_key`,
      [SYSTEM_ACTOR_ID],
    );
    expect(Object.fromEntries(rates.map((r) => [r.k, Number(r.v)]))).toEqual({
      delivery_other_per_m3: 2125,
      diesel_per_l: 1700,
      overhead_per_m3: 3000,
      plant_per_m3: 4000,
      pump_per_m3: 4000,
    });
    const norm = await w.sup<{ trip: string }>(
      `select per_trip_ml::text trip from fuel_norm where created_by = $1 and truck_kind = 'mixer'`,
      [SYSTEM_ACTOR_ID],
    );
    expect(norm[0]!.trip).toBe('22000');
  });

  it('holds the five fictitious FX- recipes with the doses of the spec, and the mapping of class and method to them', async () => {
    const lines = await w.sup<{
      code: string;
      label: string;
      n: string;
      cement: string | null;
      water: string | null;
    }>(
      `select t.code, t.label, count(l.id)::text n,
              max(l.qty_per_m3) filter (where c.name_fr like 'FX CPJ 55%')::text cement,
              max(l.qty_per_m3) filter (where c.name_fr like 'FX EAU%')::text water
         from concrete_type t join recette r on r.concrete_type_id = t.id join recette_line l on l.recette_id = r.id join component c on c.id = l.component_id
        where t.code like 'FXB%' group by t.code, t.label order by t.code`,
    );
    expect(lines.map((r) => [r.label, Number(r.n), r.cement, r.water])).toEqual([
      ['FX-B20-G', 7, '300000', '170'],
      ['FX-B25-G', 7, '330000', '170'],
      ['FX-B25-P', 8, '350000', '180'],
      ['FX-B30-H', 9, '380000', '175'],
      ['FX-B30-P', 8, '380000', '175'],
    ]);
    const map = await w.sup<{ cls: string; m: string; recipe: string }>(
      `select c.code cls, m.discharge_method m, f.label recipe from class_method_recette m
         join concrete_type c on c.id = m.concrete_type_id join recette r on r.id = m.recette_id join concrete_type f on f.id = r.concrete_type_id
        where m.created_by = $1 order by 1, 2`,
      [SYSTEM_ACTOR_ID],
    );
    expect(map.map((x) => [x.cls, x.m, x.recipe])).toEqual([
      ['B20', 'GOULOTTE', 'FX-B20-G'],
      ['B25', 'GOULOTTE', 'FX-B25-G'],
      ['B25', 'POMPE', 'FX-B25-P'],
      ['B30', 'POMPE', 'FX-B30-P'],
    ]);
  });
});
