// Applies db/migrations as the migrator role.
//   corepack pnpm db:migrate
import { existsSync, readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { installJobQueue } from '../src/modules/clock/service/job-scheduler.ts';
import { handleHelp } from './cli-help';

export const MIGRATIONS_FOLDER = 'db/migrations';

export const SEED_ROLE_GRANTS_FILE = 'db/seed/seed-role.sql';

/** The pilot seed's role exists only in simulation databases; where it can log in, it gets its (idempotent) grants. */
export async function applySeedRoleGrants(pool: pg.Pool): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from pg_roles where rolname = 'belgobeton_seed' and rolcanlogin`,
  );
  if (!rowCount) return false;
  await pool.query(readFileSync(SEED_ROLE_GRANTS_FILE, 'utf8'));
  return true;
}

export async function runMigrations(migratorUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: migratorUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    await applySeedRoleGrants(pool);
    // R17-03: on every run (not only the one that applied 0212): their sessions are revoked, and a usable reserved-role account stops it.
    // R18-03: the revocation is its OWN committed statement, so the refusal that follows cannot roll it back.
    await pool.query('select public.revoke_reserved_sessions()');
    await pool.query('select public.admit_no_reserved_accounts()');
  } finally {
    await pool.end();
  }
  // pg-boss owns its schema (T23); it is installed with the migrator and handed to the system role.
  await installJobQueue(migratorUrl);
}

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const { loadMaintenanceEnv } = await import('../src/lib/env.ts');
  await runMigrations(loadMaintenanceEnv(process.env).DATABASE_URL_MIGRATOR);
  console.log('Migrations applied');
}
