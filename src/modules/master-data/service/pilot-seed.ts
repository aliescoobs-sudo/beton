import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { SYSTEM_ACTOR_ID } from '@/modules/platform-security';
import { seedCostAssumptions } from './pilot-cost-seed';

export interface SeedGuardEnv {
  SIMULATION_ENABLED: boolean;
  REAL_DATA: boolean;
  NODE_ENV: string;
  /** The training instance (T1) may seed the same fictitious data, in a production build, but never as APP_ENV=production. */
  TRAINING_MODE?: boolean;
  APP_ENV?: string | undefined;
}

/**
 * AC-SIM-02: the pilot seed runs only in simulation, never on real data or in production. T1: it also runs for the training instance
 * (TRAINING_MODE=true, not APP_ENV=production, no real data), whose build is a production build.
 */
export function assertSeedAllowed(env: SeedGuardEnv): void {
  if (env.REAL_DATA) throw new Error('Pilot seed refused: REAL_DATA is "true"');
  if (env.TRAINING_MODE) {
    if (env.APP_ENV === 'production') throw new Error('Pilot seed refused: APP_ENV is "production"');
    return;
  }
  if (!env.SIMULATION_ENABLED) throw new Error('Pilot seed refused: SIMULATION_ENABLED is not "true"');
  if (env.NODE_ENV === 'production') throw new Error('Pilot seed refused: NODE_ENV is "production"');
}

const COMPONENTS = [
  { fr: 'Ciment', ar: 'إسمنت', unit: 'g' },
  { fr: 'Sable', ar: 'رمل', unit: 'g' },
  { fr: 'Gravette 8/15', ar: 'حصى 8/15', unit: 'g' },
  { fr: 'Gravette 15/25', ar: 'حصى 15/25', unit: 'g' },
  { fr: 'Eau', ar: 'ماء', unit: 'L' },
  { fr: 'Adjuvant', ar: 'مادة مضافة', unit: 'mL' },
] as const;

const PURCHASE_UNITS = [
  ['Ciment', 't', 1_000_000],
  ['Ciment', 'sac 50 kg', 50_000],
  ['Sable', 't', 1_000_000],
  ['Gravette 8/15', 't', 1_000_000],
  ['Gravette 15/25', 't', 1_000_000],
  ['Eau', 'm³', 1_000],
  ['Adjuvant', 'L', 1_000],
] as const;

const CONCRETE_TYPES = ['B10', 'B12', 'B15', 'B20', 'B25', 'B30', 'B35'] as const;

// T15. Every value below is fake or an assumption to confirm with the plant (decision 79); all names say "fictif".
/** The 5 zones of D53, with fixed ids: the first 0017 already put them in the dev database. */
const ZONES = [
  ['019c0000-0000-7000-8000-000000000001', 'Tétouan centre', 20],
  ['019c0000-0000-7000-8000-000000000002', 'Martil', 25],
  ['019c0000-0000-7000-8000-000000000003', "M'diq", 30],
  ['019c0000-0000-7000-8000-000000000004', 'Fnideq', 45],
  ['019c0000-0000-7000-8000-000000000005', 'Oued Laou', 60],
] as const;

const SUPPLIERS = [
  ['Ciments du Nord (fictif)', 'cement'],
  ['Carrière Rif Granulats (fictif)', 'aggregates'],
  ['Adjuvants Maghreb (fictif)', 'admixture'],
  ['Régie des eaux (fictif)', 'other'],
  ['Station Martil Carburants (fictif)', 'fuel'],
] as const;

const CLIENTS = [
  ['Entreprise Atlas BTP (fictif)', 'company', 'Tétouan centre'],
  ['Promotion Martil Immo (fictif)', 'company', 'Martil'],
  ['SARL Rif Construction (fictif)', 'company', "M'diq"],
  ['Coopérative Oued Laou (fictif)', 'company', 'Oued Laou'],
  ['Karim Test (fictif)', 'person', 'Fnideq'],
] as const;

/** Quantities per m³ in base units: grams, litres, millilitres (assumed values). */
const RECETTES = {
  B20: {
    Ciment: 300_000,
    Sable: 820_000,
    'Gravette 8/15': 420_000,
    'Gravette 15/25': 620_000,
    Eau: 185,
    Adjuvant: 3_000,
  },
  B25: {
    Ciment: 350_000,
    Sable: 800_000,
    'Gravette 8/15': 400_000,
    'Gravette 15/25': 600_000,
    Eau: 180,
    Adjuvant: 3_500,
  },
  B30: {
    Ciment: 400_000,
    Sable: 780_000,
    'Gravette 8/15': 380_000,
    'Gravette 15/25': 580_000,
    Eau: 175,
    Adjuvant: 4_000,
  },
} as const;

/** component, supplier, purchase unit, centimes HT per unit (1 450,00 MAD/t of cement = 145 000). */
const PURCHASE_PRICES = [
  ['Ciment', 'Ciments du Nord (fictif)', 't', 145_000],
  ['Sable', 'Carrière Rif Granulats (fictif)', 't', 9_000],
  ['Gravette 8/15', 'Carrière Rif Granulats (fictif)', 't', 11_000],
  ['Gravette 15/25', 'Carrière Rif Granulats (fictif)', 't', 10_500],
  ['Eau', 'Régie des eaux (fictif)', 'm³', 1_200],
  ['Adjuvant', 'Adjuvants Maghreb (fictif)', 'L', 2_500],
] as const;

/** List prices, centimes HT per m³ (780,00 MAD = 78 000). */
const SELLING_PRICES = [
  ['B20', 78_000],
  ['B25', 85_000],
  ['B30', 92_000],
] as const;

const TRUCKS = [
  ['T1', '10101-A-6'],
  ['T2', '10102-A-6'],
  ['T3', '10103-A-6'],
  ['T4', '10104-A-6'],
] as const;

/** Prices apply from the start of the pilot year; the simulated clock never starts before it. */
const EFFECTIVE_FROM = '2026-01-01';

/**
 * Pilot master data (fake or still-assumed values, decision 79). Runs as the system actor on the belgobeton_system
 * pool, after RLS and the audit triggers exist, so every row is audited (actor system, request id "seed").
 * Idempotent: existing rows are left alone and consume no code.
 */
export async function seedPilotMasterData(systemPool: pg.Pool, env: SeedGuardEnv): Promise<void> {
  assertSeedAllowed(env);
  await withRlsContext(
    systemPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'seed' },
    async (tx) => {
      for (const c of COMPONENTS) {
        await tx.query(
          `insert into component (id, code, name_fr, name_ar, base_unit)
         select gen_random_uuid(), public.next_code('CMP', 2), $1, $2, $3
          where not exists (select 1 from component where lower(name_fr) = lower($1))`,
          [c.fr, c.ar, c.unit],
        );
      }
      // SPEC-stock-engine-gaps §4, D237: the count tolerance is DATA flagged as an assumption: 200 bp by default, 0 for the admixture (counted by container).
      await tx.query(
        `insert into stock_count_tolerance (plant_id, component_id, tolerance_bp, floor_qty, effective_from, is_assumption, created_by, reason)
         select null, null, 200, 0, date '2000-01-01', true, $1, 'assumption A1: 2 % default tolerance, to confirm with the owner'
          where not exists (select 1 from stock_count_tolerance where plant_id is null and component_id is null and effective_from = date '2000-01-01')`,
        [SYSTEM_ACTOR_ID],
      );
      await tx.query(
        `insert into stock_count_tolerance (plant_id, component_id, tolerance_bp, floor_qty, effective_from, is_assumption, created_by, reason)
         select null, c.id, 0, 0, date '2000-01-01', true, $1, 'assumption A1: admixture counted by container, no tolerance, to confirm with the owner'
           from component c
          where lower(c.name_fr) = 'adjuvant'
            and not exists (select 1 from stock_count_tolerance t where t.plant_id is null and t.component_id = c.id and t.effective_from = date '2000-01-01')`,
        [SYSTEM_ACTOR_ID],
      );
      for (const [component, label, factor] of PURCHASE_UNITS) {
        await tx.query(
          `insert into purchase_unit (id, component_id, label, factor_to_base)
         select gen_random_uuid(), c.id, $2, $3 from component c where lower(c.name_fr) = lower($1)
         on conflict do nothing`,
          [component, label, factor],
        );
      }
      for (const code of CONCRETE_TYPES) {
        await tx.query(
          `insert into concrete_type (id, code, label) values (gen_random_uuid(), $1, $2) on conflict (code) do nothing`,
          [code, `Béton ${code}`],
        );
      }
      await seedZonesPartiesAndTrucks(tx);
      await seedRecettesAndPrices(tx);
      // T16 G5: the A1 cost and price-grid assumptions (every row flagged is_assumption), the five fictitious FX- recipes
      await seedCostAssumptions(tx);
    },
  );
}

type Tx = Parameters<Parameters<typeof withRlsContext>[2]>[0];

async function seedZonesPartiesAndTrucks(tx: Tx): Promise<void> {
  for (const [id, name, oneWayMin] of ZONES) {
    await tx.query(`insert into zone (id, name, one_way_min) values ($1, $2, $3) on conflict do nothing`, [
      id,
      name,
      oneWayMin,
    ]);
  }
  for (const [name, category] of SUPPLIERS) {
    await tx.query(
      `insert into supplier (id, code, name, category)
       select gen_random_uuid(), public.next_code('FRN', 2), $1, $2
        where not exists (select 1 from supplier where lower(name) = lower($1))`,
      [name, category],
    );
  }
  for (const [name, kind, zone] of CLIENTS) {
    await tx.query(
      `insert into client (id, code, name, kind, default_zone_id)
       select gen_random_uuid(), public.next_code('CLT', 3), $1, $2, (select id from zone where name = $3)
        where not exists (select 1 from client where lower(name) = lower($1))`,
      [name, kind, zone],
    );
  }
  for (const [code, plate] of TRUCKS) {
    await tx.query(
      `insert into truck (id, code, plate) values (gen_random_uuid(), $1, $2) on conflict do nothing`,
      [code, plate],
    );
  }
}

/** Versioned tables are insert-only: a scope that already has a version is left alone, whatever its date. */
async function seedRecettesAndPrices(tx: Tx): Promise<void> {
  for (const [code, lines] of Object.entries(RECETTES)) {
    const created = await tx.query<{ id: string }>(
      `insert into recette (id, concrete_type_id, version, effective_from, created_by)
       select gen_random_uuid(), t.id, 1, $2, $3 from concrete_type t
        where t.code = $1 and not exists (select 1 from recette r where r.concrete_type_id = t.id)
       returning id`,
      [code, EFFECTIVE_FROM, SYSTEM_ACTOR_ID],
    );
    const recetteId = created.rows[0]?.id;
    if (!recetteId) continue;
    for (const [component, qty] of Object.entries(lines)) {
      await tx.query(
        `insert into recette_line (id, recette_id, component_id, qty_per_m3)
         select gen_random_uuid(), $1, c.id, $3 from component c where lower(c.name_fr) = lower($2)`,
        [recetteId, component, qty],
      );
    }
  }
  for (const [component, supplier, unit, centimes] of PURCHASE_PRICES) {
    await tx.query(
      `insert into purchase_price (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by)
       select gen_random_uuid(), c.id, s.id, u.id, $4, $5, $6
         from component c
         join supplier s on lower(s.name) = lower($2)
         join purchase_unit u on u.component_id = c.id and u.label = $3
        where lower(c.name_fr) = lower($1)
          and not exists (select 1 from purchase_price p where p.component_id = c.id)`,
      [component, supplier, unit, centimes, EFFECTIVE_FROM, SYSTEM_ACTOR_ID],
    );
  }
  for (const [code, centimes] of SELLING_PRICES) {
    await tx.query(
      `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
       select gen_random_uuid(), t.id, null, $2, $3, $4 from concrete_type t
        where t.code = $1
          and not exists (select 1 from selling_price p where p.concrete_type_id = t.id and p.client_id is null)`,
      [code, centimes, EFFECTIVE_FROM, SYSTEM_ACTOR_ID],
    );
  }
  // One per-client override (AC-MD-03/10 demo): Atlas BTP pays B25 at 820,00 MAD/m³, with the mandatory reason.
  await tx.query(
    `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, reason, created_by)
     select gen_random_uuid(), t.id, c.id, 82000, $1, 'Remise volume (fictif)', $2
       from concrete_type t join client c on lower(c.name) = lower('Entreprise Atlas BTP (fictif)')
      where t.code = 'B25'
        and not exists (select 1 from selling_price p where p.concrete_type_id = t.id and p.client_id = c.id)`,
    [EFFECTIVE_FROM, SYSTEM_ACTOR_ID],
  );
}
