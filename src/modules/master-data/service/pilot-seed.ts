import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { SYSTEM_ACTOR_ID } from '@/modules/platform-security';

export interface SeedGuardEnv {
  SIMULATION_ENABLED: boolean;
  REAL_DATA: boolean;
  NODE_ENV: string;
}

/** AC-SIM-02: the pilot seed runs only in simulation, never on real data or in production. */
export function assertSeedAllowed(env: SeedGuardEnv): void {
  if (!env.SIMULATION_ENABLED) throw new Error('Pilot seed refused: SIMULATION_ENABLED is not "true"');
  if (env.REAL_DATA) throw new Error('Pilot seed refused: REAL_DATA is "true"');
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

const CONCRETE_TYPES = ['B12', 'B20', 'B25', 'B30'] as const;

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
    },
  );
}
