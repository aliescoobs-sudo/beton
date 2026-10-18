// Creates the database roles and databases (local docker-compose only; needs the superuser).
// Idempotent: safe to run again, it re-applies attributes and passwords from .env.local.
//   corepack pnpm db:bootstrap
import { existsSync } from 'node:fs';
import pg from 'pg';
import { z } from 'zod';
import { type Env, loadEnv } from '../src/lib/env.ts';

export const TEST_DATABASE = 'belgobeton_test';

const ROLE_NAMES = {
  migrator: 'belgobeton_migrator',
  app: 'belgobeton_app',
  auth: 'belgobeton_auth',
  system: 'belgobeton_system',
} as const;

function roleUrls(env: Env) {
  return [
    { name: ROLE_NAMES.migrator, url: env.DATABASE_URL_MIGRATOR },
    { name: ROLE_NAMES.app, url: env.DATABASE_URL_APP },
    { name: ROLE_NAMES.auth, url: env.DATABASE_URL_AUTH },
    { name: ROLE_NAMES.system, url: env.DATABASE_URL_SYSTEM },
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

/** Creates or re-aligns the four login roles: no elevated attribute, password from the env URLs. */
export async function ensureRoles(env: Env): Promise<void> {
  await withClient(superuserUrl(env, 'postgres'), async (client) => {
    for (const role of roleUrls(env)) {
      const url = new URL(role.url);
      if (decodeURIComponent(url.username) !== role.name) {
        throw new Error(`Database URL for ${role.name} must use user "${role.name}"`);
      }
      const password = decodeURIComponent(url.password);
      if (password.length < 16) throw new Error(`Password for ${role.name} must be at least 16 characters`);

      const exists = await client.query('select 1 from pg_roles where rolname = $1', [role.name]);
      const verb = exists.rowCount ? 'ALTER' : 'CREATE';
      await client.query(
        `${verb} ROLE ${client.escapeIdentifier(role.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ` +
          `NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD ${client.escapeLiteral(password)}`,
      );
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
    const all = Object.values(ROLE_NAMES)
      .map((name) => client.escapeIdentifier(name))
      .join(', ');
    // Nothing for PUBLIC: no default CONNECT or TEMP on the database.
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${all}`);
    // The migrator owns the public schema, so migrations (not this script) decide its grants.
    await client.query(`ALTER SCHEMA public OWNER TO ${client.escapeIdentifier(ROLE_NAMES.migrator)}`);
  });
}

/** Drops and recreates the integration-test database (it holds immutable audit rows). */
export async function recreateTestDatabase(env: Env): Promise<void> {
  await withClient(superuserUrl(env, 'postgres'), (client) =>
    client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(TEST_DATABASE)} WITH (FORCE)`),
  );
  await ensureDatabase(env, TEST_DATABASE);
}

if (import.meta.main) {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const env = loadEnv(process.env);
  const databases = [new URL(env.DATABASE_URL_MIGRATOR).pathname.slice(1), TEST_DATABASE];
  await ensureRoles(env);
  for (const database of databases) await ensureDatabase(env, database);
  console.log(`Bootstrapped roles and databases: ${databases.join(', ')}`);
}
