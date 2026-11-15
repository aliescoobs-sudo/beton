import type pg from 'pg';
import { SYSTEM_ACTOR_ID } from '@/modules/platform-security';

/**
 * T16 G5 (SPEC-cost-margin §11, §12; D236, D237): the A1 assumption set, as PILOT SEED DATA only (decision 79: migrations insert no data, and no cost constant lives in the
 * application code). EVERY row below is flagged is_assumption = true and carries a source note; none is company data (diesel about 17 DH/L is a web reference of 15 Nov 2026, the rest is invented).
 * A real database never receives it (the seed refuses REAL_DATA and production); without it the cost snapshot records `incomplete` with the missing keys.
 * Money is integer centimes. Doses are in the base unit per m3 (grams, litres): kg per m3 x 1000 for the solids and the admixtures.
 */
type Tx = pg.PoolClient;

/** The A1 grid, GOULOTTE, DH per m3 HT in centimes; POMPE = GOULOTTE + 50 DH (the pump is included, never invoiced apart). */
const GRID_GOULOTTE: readonly (readonly [string, number])[] = [
  ['B10', 60_000],
  ['B15', 66_000],
  ['B20', 74_000],
  ['B25', 82_000],
  ['B30', 89_000],
  ['B35', 93_000],
];
const POMPE_SUPPLEMENT_CENTIMES = 5_000;

/** key, centimes (A1: delivery about 68 DH/m3 = fuel of a 22 L trip of 8 m3 plus 21,25 DH of driver and maintenance; pump, plant, overheads as the spec). */
const COST_RATES: readonly (readonly [string, number, string])[] = [
  ['diesel_per_l', 1_700, 'assumption A1: diesel about 17 DH/L (web reference of 15 Nov 2026)'],
  [
    'delivery_other_per_m3',
    2_125,
    'assumption A1: driver, maintenance and tyres, so that delivery is about 68 DH/m3 with the fuel',
  ],
  ['pump_per_m3', 4_000, 'assumption A1: pump about 40 DH/m3 (invented)'],
  ['plant_per_m3', 4_000, 'assumption A1: plant about 40 DH/m3 (invented)'],
  ['overhead_per_m3', 3_000, 'assumption A1: overheads about 30 DH/m3 (invented)'],
];

/** A mixer burns about 22 L per 30 km round trip of 8 m3 (assumption A1), in millilitres. */
const MIXER_PER_TRIP_ML = 22_000;

/** nameFr, nameAr, base unit, purchase unit label, grams or litres per purchase unit, price centimes per unit, transport centimes per unit (invented). */
const FX_COMPONENTS = [
  ['FX GI (fictif)', 'FX حصى GI (وهمي)', 'g', 't', 1_000_000, 13_000, 4_000],
  ['FX S/C (fictif)', 'FX رمل S/C (وهمي)', 'g', 't', 1_000_000, 11_000, 4_000],
  ['FX S/M (fictif)', 'FX رمل S/M (وهمي)', 'g', 't', 1_000_000, 12_000, 4_000],
  ['FX GII (fictif)', 'FX حصى GII (وهمي)', 'g', 't', 1_000_000, 13_000, 4_000],
  ['FX CPJ 55 (fictif)', 'FX إسمنت CPJ 55 (وهمي)', 'g', 't', 1_000_000, 120_000, 2_000],
  ['FX EAU (fictif)', 'FX ماء (وهمي)', 'L', 'm³', 1_000, 1_200, 0],
  ['FX ADJ 15 (fictif)', 'FX مضاف 15 (وهمي)', 'g', 'kg', 1_000, 1_800, 0],
  ['FX ADJ 16 (fictif)', 'FX مضاف 16 (وهمي)', 'g', 'kg', 1_000, 1_800, 0],
  ['FX HYD 17 (fictif)', 'FX مانع رطوبة 17 (وهمي)', 'g', 'kg', 1_000, 1_800, 0],
] as const;

/** The five fictitious recipes (SPEC §12): kg per m3 of GI, S/C, S/M, GII, CPJ55, EAU (L), 15, 16, 17. Invented, deliberately round. */
const FX_RECIPES: readonly (readonly [string, string, readonly number[]])[] = [
  ['FXB20G', 'FX-B20-G', [400, 350, 350, 450, 300, 170, 2, 0, 0]],
  ['FXB25G', 'FX-B25-G', [400, 350, 350, 440, 330, 170, 2, 0, 0]],
  ['FXB25P', 'FX-B25-P', [380, 360, 360, 420, 350, 180, 3, 1, 0]],
  ['FXB30P', 'FX-B30-P', [370, 360, 350, 420, 380, 175, 3, 1, 0]],
  ['FXB30H', 'FX-B30-H', [370, 360, 350, 420, 380, 175, 3, 1, 2]],
];

/** (class, method) -> recette code: the default industrial recette of that class and method (FX-B30-H, the hydrofuge variant, is not mapped: it is chosen by hand). */
const FX_MAPPING: readonly (readonly [string, string, string])[] = [
  ['B20', 'GOULOTTE', 'FXB20G'],
  ['B25', 'GOULOTTE', 'FXB25G'],
  ['B25', 'POMPE', 'FXB25P'],
  ['B30', 'POMPE', 'FXB30P'],
];

/** Prices apply from the start of the pilot year (the simulated clock never starts before it). */
const A1_FROM = '2026-01-01';
const A1 = 'assumption A1';

export async function seedCostAssumptions(tx: Tx): Promise<void> {
  const by = SYSTEM_ACTOR_ID;
  // the price grid
  for (const [cls, goulotte] of GRID_GOULOTTE) {
    for (const [method, price] of [
      ['GOULOTTE', goulotte],
      ['POMPE', goulotte + POMPE_SUPPLEMENT_CENTIMES],
    ] as const) {
      await tx.query(
        `insert into price_grid (concrete_type_id, discharge_method, price_ht_per_m3_centimes, effective_from, is_assumption, reason, created_by)
         select t.id, $2, $3, $4, true, $5, $6 from concrete_type t
          where t.code = $1 and not exists (select 1 from price_grid g where g.concrete_type_id = t.id and g.discharge_method = $2)`,
        [cls, method, price, A1_FROM, `${A1}: illustrative selling grid, to confirm with the owner`, by],
      );
    }
  }
  // the cost rates and the fuel norm
  for (const [key, value, note] of COST_RATES) {
    await tx.query(
      `insert into cost_rate (rate_key, unit, value_centimes, effective_from, plant_id, is_assumption, source_note, reason, created_by)
       select $1, case when $1 = 'diesel_per_l' then 'centimes_per_l' else 'centimes_per_m3' end, $2, $3, null, true, $4, $5, $6
        where not exists (select 1 from cost_rate r where r.rate_key = $1 and r.plant_id is null)`,
      [key, value, A1_FROM, note, `${A1}: to replace by the real value`, by],
    );
  }
  await tx.query(
    `insert into fuel_norm (truck_kind, truck_id, per_trip_ml, effective_from, is_assumption, source_note, reason, created_by)
     select 'mixer', null, $1, $2, true, $3, $4, $5
      where not exists (select 1 from fuel_norm n where n.truck_kind = 'mixer')`,
    [
      MIXER_PER_TRIP_ML,
      A1_FROM,
      `${A1}: about 22 L per 30 km round trip`,
      `${A1}: to replace by the measured value`,
      by,
    ],
  );
  // the fictitious components, their purchase units, their delivered prices
  for (const [fr, ar, base, unit, factor, price, transport] of FX_COMPONENTS) {
    await tx.query(
      `insert into component (id, code, name_fr, name_ar, base_unit)
       select gen_random_uuid(), public.next_code('CMP', 2), $1, $2, $3
        where not exists (select 1 from component where lower(name_fr) = lower($1))`,
      [fr, ar, base],
    );
    await tx.query(
      `insert into purchase_unit (id, component_id, label, factor_to_base)
       select gen_random_uuid(), c.id, $2, $3 from component c where lower(c.name_fr) = lower($1) on conflict do nothing`,
      [fr, unit, factor],
    );
    await tx.query(
      `insert into purchase_price (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by)
       select gen_random_uuid(), c.id, s.id, u.id, $3, $4, $5
         from component c
         join purchase_unit u on u.component_id = c.id and u.label = $2
         join supplier s on lower(s.name) = lower('Carrière Rif Granulats (fictif)')
        where lower(c.name_fr) = lower($1) and not exists (select 1 from purchase_price p where p.component_id = c.id)`,
      [fr, unit, price, A1_FROM, by],
    );
    await tx.query(
      `insert into purchase_price_transport (purchase_price_id, transport_centimes, is_assumption, source_note, reason, created_by)
       select p.id, $2, true, $3, $4, $5 from purchase_price p join component c on c.id = p.component_id
        where lower(c.name_fr) = lower($1) and not exists (select 1 from purchase_price_transport x where x.purchase_price_id = p.id)`,
      [
        fr,
        transport,
        `${A1}: invented delivered-to-plant transport`,
        `${A1}: to replace by the supplier invoice`,
        by,
      ],
    );
  }
  // the five fictitious recipes, each its own industrial type (the commercial class stays B20, B25, B30)
  for (const [typeCode, label, doses] of FX_RECIPES) {
    await tx.query(
      `insert into concrete_type (id, code, label) values (gen_random_uuid(), $1, $2) on conflict (code) do nothing`,
      [typeCode, label],
    );
    const made = await tx.query<{ id: string }>(
      `insert into recette (id, concrete_type_id, version, effective_from, created_by)
       select gen_random_uuid(), t.id, 1, $2, $3 from concrete_type t
        where t.code = $1 and not exists (select 1 from recette r where r.concrete_type_id = t.id) returning id`,
      [typeCode, A1_FROM, by],
    );
    const recetteId = made.rows[0]?.id;
    if (!recetteId) continue;
    for (const [i, [fr]] of FX_COMPONENTS.entries()) {
      const dose = doses[i] ?? 0;
      if (dose === 0) continue;
      // kg per m3 of a solid or an admixture is grams per m3; water is already litres per m3
      const base = fr.includes('EAU') ? dose : dose * 1_000;
      await tx.query(
        `insert into recette_line (id, recette_id, component_id, qty_per_m3)
         select gen_random_uuid(), $1, c.id, $3 from component c where lower(c.name_fr) = lower($2)`,
        [recetteId, fr, base],
      );
    }
  }
  for (const [cls, method, typeCode] of FX_MAPPING) {
    await tx.query(
      `insert into class_method_recette (concrete_type_id, discharge_method, plant_id, recette_id, effective_from, is_assumption, reason, created_by)
       select c.id, $2, null, r.id, $4, true, $5, $6
         from concrete_type c, concrete_type f join recette r on r.concrete_type_id = f.id
        where c.code = $1 and f.code = $3
          and not exists (select 1 from class_method_recette m where m.concrete_type_id = c.id and m.discharge_method = $2 and m.plant_id is null)`,
      [cls, method, typeCode, A1_FROM, `${A1}: fictitious industrial recette for the class and method`, by],
    );
  }
}
