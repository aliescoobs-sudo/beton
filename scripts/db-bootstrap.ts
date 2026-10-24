// Creates the database roles and databases (local docker-compose only; needs the superuser).
// Idempotent: safe to run again, it re-applies attributes and passwords from .env.local.
//   corepack pnpm db:bootstrap
import { existsSync } from 'node:fs';
import pg from 'pg';
import { z } from 'zod';
import { type Env, loadBackupUrl, loadEnv, loadSeedUrl, seedRoleAllowed } from '../src/lib/env.ts';
import { handleHelp } from './cli-help';

export const TEST_DATABASE = 'belgobeton_test';
export const E2E_DATABASE = 'belgobeton_e2e';
export const DDL_SCRATCH_DATABASE = 'belgobeton_ddl_scratch';
export const RESTORE_TEST_DATABASE = 'belgobeton_restore_test';
export const SCENARIO_TEST_DATABASE = 'belgobeton_scenario_test';
/** The only databases scripts may drop: never the dev (or any real) database. */
const THROWAWAY_DATABASES: readonly string[] = [
  TEST_DATABASE,
  E2E_DATABASE,
  DDL_SCRATCH_DATABASE,
  RESTORE_TEST_DATABASE,
  SCENARIO_TEST_DATABASE,
];

const ROLE_NAMES = {
  migrator: 'belgobeton_migrator',
  app: 'belgobeton_app',
  auth: 'belgobeton_auth',
  system: 'belgobeton_system',
  backup: 'belgobeton_backup',
  seed: 'belgobeton_seed',
} as const;

function roleUrls(env: Env, seedUrl?: string) {
  return [
    { name: ROLE_NAMES.migrator, url: env.DATABASE_URL_MIGRATOR },
    { name: ROLE_NAMES.app, url: env.DATABASE_URL_APP },
    { name: ROLE_NAMES.auth, url: env.DATABASE_URL_AUTH },
    { name: ROLE_NAMES.system, url: env.DATABASE_URL_SYSTEM },
    { name: ROLE_NAMES.backup, url: loadBackupUrl(process.env) },
    ...(seedUrl ? [{ name: ROLE_NAMES.seed, url: seedUrl }] : []),
  ];
}

/** Superuser connection string for `database`, on the host/port of the migrator URL. */
export function superuserUrl(env: Env, database: string): string {
  const password = z
    .string()
    .min(16, { error: 'POSTGRES_SUPERUSER_PASSWORD must be at least 16 characters' })
    .parse(process.env.POSTGRES_SUPERUSER_PASSWORD);
  const url = new URL(env.DATABASE_URL_MIGRATOR);
  url.username = 'postgres';
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates or re-aligns the login roles: no elevated attribute, password from the env URLs. The seed role is handled
 * only with `seedUrl` (callers pass it only in simulation, see seedRoleAllowed): without it, an existing seed role is
 * switched to NOLOGIN, so flipping a database to real data or production disables the seed's access.
 */
export async function ensureRoles(env: Env, seedUrl?: string): Promise<void> {
  await withClient(superuserUrl(env, 'postgres'), async (client) => {
    for (const role of roleUrls(env, seedUrl)) {
      const url = new URL(role.url);
      if (decodeURIComponent(url.username) !== role.name) {
        throw new Error(`Database URL for ${role.name} must use user "${role.name}"`);
      }
      const password = decodeURIComponent(url.password);
      if (password.length < 16) throw new Error(`Password for ${role.name} must be at least 16 characters`);

      const exists = await client.query('select 1 from pg_roles where rolname = $1', [role.name]);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      // Only the backup role may bypass RLS (pg_dump must see every row); it can read, never write.
      const rls = role.name === ROLE_NAMES.backup ? 'BYPASSRLS INHERIT' : 'NOBYPASSRLS NOINHERIT';
      await client.query(
        `${verb} ROLE ${client.escapeIdentifier(role.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ` +
          `${rls} NOREPLICATION PASSWORD ${client.escapeLiteral(password)}`,
      );
    }
    await client.query(`GRANT pg_read_all_data TO ${client.escapeIdentifier(ROLE_NAMES.backup)}`);
    if (!seedUrl) {
      const seed = await client.query('select 1 from pg_roles where rolname = $1', [ROLE_NAMES.seed]);
      if (seed.rowCount) await client.query(`ALTER ROLE ${client.escapeIdentifier(ROLE_NAMES.seed)} NOLOGIN`);
    }
  });
}

/** Creates `database` owned by the migrator if missing, then removes PUBLIC access. */
export async function ensureDatabase(env: Env, database: string): Promise<void> {
  await withClient(superuserUrl(env, 'postgres'), async (client) => {
    const exists = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (!exists.rowCount) {
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(database)} OWNER ${client.escapeIdentifier(ROLE_NAMES.migrator)}`,
      );
    }
  });

  await withClient(superuserUrl(env, database), async (client) => {
    const db = client.escapeIdentifier(database);
    const existing = await client.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = any($1)',
      [Object.values(ROLE_NAMES)],
    );
    const all = existing.rows.map((r) => client.escapeIdentifier(r.rolname)).join(', ');
    // Nothing for PUBLIC: no default CONNECT or TEMP on the database.
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${all}`);
    // The migrator owns the public schema, so migrations (not this script) decide its grants.
    await client.query(`ALTER SCHEMA public OWNER TO ${client.escapeIdentifier(ROLE_NAMES.migrator)}`);
  });
}

/** Drops and recreates a throwaway database (test/e2e: they hold immutable audit rows). Never the dev database. */
export async function recreateDatabase(env: Env, database: string): Promise<void> {
  if (!THROWAWAY_DATABASES.includes(database)) {
    throw new Error(
      `Refusing to recreate "${database}": only ${THROWAWAY_DATABASES.join(', ')} may be dropped`,
    );
  }
  await withClient(superuserUrl(env, 'postgres'), (client) =>
    client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(database)} WITH (FORCE)`),
  );
  await ensureDatabase(env, database);
}

export const recreateTestDatabase = (env: Env) => recreateDatabase(env, TEST_DATABASE);

if (import.meta.main) {
  handleHelp(import.meta.url);
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  // Ops secrets (superuser, backup role, age identity) live in .env.ops, which Next.js never loads.
  if (existsSync('.env.ops')) process.loadEnvFile('.env.ops');
  const env = loadEnv(process.env);
  const databases = [new URL(env.DATABASE_URL_MIGRATOR).pathname.slice(1), TEST_DATABASE];
  // The seed role is created only in simulation (never with REAL_DATA or in production).
  await ensureRoles(env, seedRoleAllowed(process.env) ? loadSeedUrl(process.env) : undefined);
  for (const database of databases) await ensureDatabase(env, database);
  console.log(`Bootstrapped roles and databases: ${databases.join(', ')}`);
}
