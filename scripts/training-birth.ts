// Provenance of a training database (R13-01, R14-13). WHAT THIS IS, honestly: a CONSUMABLE MARKER in the cluster's `postgres`
// maintenance database, written once by the stock stack's initialisation step (scripts/training/db-init, run by the postgres image only
// when it initialises an EMPTY data directory) and spent, once, by the training seed. It is bound to a business database NAME (at the
// first claim for the initialisation token; at creation for the one `reset:training` mints). Together with the exact emptiness check of
// the seed it refuses the ordinary mistakes: a database restored or hand-built on a cluster that never had the marker, a second seed on
// the same volume, a seed for another database name.
// WHAT IT IS NOT: a signed token or an attestation. A superuser, or anyone who can restore the maintenance database, a whole cluster
// or a physical snapshot, can carry an UNUSED marker into another cluster. A fresh, dedicated volume therefore stays an operator fact
// that MUST be established outside this code (docs/checkpoints/CP-TRAINING.md): a successful seed is not proof the volume is new.
import pg from 'pg';
import { type MaintenanceEnv } from '../src/lib/env.ts';
import { superuserUrl } from './db-bootstrap.ts';

/** Databases of the test runners: the only ones where the seed may run without a birth token (they are dropped and rebuilt by tests). */
const TEST_DATABASES = ['belgobeton_training_test', 'belgobeton_test', 'belgobeton_e2e'];
/** The positive runner signals: vitest sets VITEST itself; the Playwright server and the screenshot tool set E2E_TEST_RUNNER. */
const RUNNER_SIGNALS = ['playwright', 'training-screens'];

export const PROVENANCE_REFUSAL =
  'training seed refused: this database was not born fresh on a stock training volume (no unused birth token for it). ' +
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

/** The business database a connection string names. */
export const databaseNameOf = (databaseUrl: string): string =>
  new URL(databaseUrl).pathname.replace(/^\//, '');

/** The row, if the table and the row exist. `to_jsonb` keeps this working on a table made before the name column existed. */
async function readBirth(c: pg.Client): Promise<{ database: string | null; consumed: boolean } | null> {
  try {
    const r = await c.query<{ db: string | null; consumed: boolean }>(
      `select to_jsonb(v)->>'database_name' as db, (v.consumed_at is not null) as consumed from public.volume_birth v`,
    );
    return r.rows[0] ? { database: r.rows[0].db, consumed: r.rows[0].consumed } : null;
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return null; // the table does not exist: no token
    throw error;
  }
}

/** True when the cluster holds an UNUSED birth token that is free or bound to THIS database (nothing is changed). */
export async function hasBirthToken(env: MaintenanceEnv, database: string): Promise<boolean> {
  return withSuperuser(env, async (c) => {
    const row = await readBirth(c);
    return !!row && !row.consumed && (row.database === null || row.database === database);
  });
}

/** True when the cluster has a birth row at all, spent or not, free or bound to this database (nothing is changed). */
export async function hasBirthRow(env: MaintenanceEnv, database: string): Promise<boolean> {
  return withSuperuser(env, async (c) => {
    const row = await readBirth(c);
    return !!row && (row.database === null || row.database === database);
  });
}

/** Consumes the birth token atomically and binds it to the database; false when there is none for this database. */
export async function claimBirthToken(env: MaintenanceEnv, database: string): Promise<boolean> {
  return withSuperuser(env, async (c) => {
    try {
      await c.query('alter table public.volume_birth add column if not exists database_name text');
      return !!(
        await c.query(
          `update public.volume_birth set consumed_at = now(), database_name = coalesce(database_name, $1)
            where consumed_at is null and (database_name is null or database_name = $1) returning token`,
          [database],
        )
      ).rowCount;
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return false;
      throw error;
    }
  });
}

/**
 * Writes a fresh token BOUND to `database`. Only `reset:training` does this, after it has verified the mode, an existing birth row and
 * the training marker and dropped that database: "born on a stock volume, seeded under a token, reset by the operator".
 */
export async function mintBirthToken(env: MaintenanceEnv, database: string): Promise<void> {
  await withSuperuser(env, async (c) => {
    await c.query(
      `create table if not exists public.volume_birth (
         only_row boolean primary key default true check (only_row),
         token uuid not null default gen_random_uuid(), born_at timestamptz not null default now(), consumed_at timestamptz,
         database_name text)`,
    );
    await c.query('alter table public.volume_birth add column if not exists database_name text');
    await c.query('revoke all on public.volume_birth from public');
    await c.query('delete from public.volume_birth');
    await c.query('insert into public.volume_birth (database_name) values ($1)', [database]);
  });
}

/**
 * The escape for the databases of the test runners needs BOTH a throwaway database name AND a positive runner signal (vitest's own
 * VITEST, or E2E_TEST_RUNNER set by the Playwright server or the screenshot tool). It is a guard against accidents by a trusted
 * programmatic caller, not a boundary against one: the deployed commands never offer it.
 */
export const isTestRunnerDatabase = (
  databaseUrl: string,
  procEnv: Record<string, string | undefined> = process.env,
): boolean =>
  TEST_DATABASES.includes(databaseNameOf(databaseUrl)) &&
  (procEnv.VITEST === 'true' || RUNNER_SIGNALS.includes(procEnv.E2E_TEST_RUNNER ?? ''));
