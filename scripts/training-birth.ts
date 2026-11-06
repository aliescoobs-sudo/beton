// R13-01: provenance of a training database. The stock stack's database-initialisation step (scripts/training/db-init, run by the
// postgres image only on the first creation of the volume) writes ONE birth token into the cluster; the training seed claims it, once.
// A volume that was not born through that step (an old volume, a restored dump, a hand-built cluster) has no token and is refused.
import pg from 'pg';
import { type MaintenanceEnv } from '../src/lib/env.ts';
import { superuserUrl } from './db-bootstrap.ts';

/** Databases of the test runners: the only ones where the seed may run without a birth token (they are dropped and rebuilt by tests). */
const TEST_DATABASES = ['belgobeton_training_test', 'belgobeton_test', 'belgobeton_e2e'];

export const PROVENANCE_REFUSAL =
  'training seed refused: this database was not born fresh on a stock training volume (no unused birth token). ' +
  'Do not reuse, restore or hand-build a training database: remove the volume and start again (docker compose down -v, then ./scripts/training-up.sh).';

async function withSuperuser<T>(env: MaintenanceEnv, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: superuserUrl(env, 'postgres') });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** True when the cluster holds an unused birth token (nothing is changed). */
export async function hasBirthToken(env: MaintenanceEnv): Promise<boolean> {
  return withSuperuser(env, async (c) => {
    try {
      return !!(await c.query('select 1 from public.volume_birth where consumed_at is null')).rowCount;
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return false; // the table does not exist: no token
      throw error;
    }
  });
}

/** Consumes the birth token atomically; false when there is none (missing table, or already used). */
export async function claimBirthToken(env: MaintenanceEnv): Promise<boolean> {
  return withSuperuser(env, async (c) => {
    try {
      return !!(
        await c.query(
          'update public.volume_birth set consumed_at = now() where consumed_at is null returning token',
        )
      ).rowCount;
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return false;
      throw error;
    }
  });
}

/**
 * Writes a fresh token. Only `reset:training` does this, after it has verified the training marker and dropped that database: the chain
 * of provenance is "born on a stock volume, seeded under a token, reset by the operator". Same SQL as the initialisation step.
 */
export async function mintBirthToken(env: MaintenanceEnv): Promise<void> {
  await withSuperuser(env, async (c) => {
    await c.query(
      `create table if not exists public.volume_birth (
         only_row boolean primary key default true check (only_row),
         token uuid not null default gen_random_uuid(), born_at timestamptz not null default now(), consumed_at timestamptz)`,
    );
    await c.query('revoke all on public.volume_birth from public');
    await c.query('delete from public.volume_birth');
    await c.query('insert into public.volume_birth default values');
  });
}

export const isTestRunnerDatabase = (databaseUrl: string): boolean =>
  TEST_DATABASES.includes(new URL(databaseUrl).pathname.replace(/^\//, ''));
