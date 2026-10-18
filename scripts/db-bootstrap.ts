// Creates the database roles and databases (local docker-compose only; needs the superuser).
// Idempotent: safe to run again, it re-applies attributes and passwords from .env.local.
//   corepack pnpm db:bootstrap
import { existsSync } from 'node:fs';
import pg from 'pg';
import { z } from 'zod';
import { loadEnv } from '../src/lib/env.ts';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const superuserPassword = z
  .string()
  .min(16, { error: 'POSTGRES_SUPERUSER_PASSWORD must be at least 16 characters' })
  .parse(process.env.POSTGRES_SUPERUSER_PASSWORD);

const ROLES = {
  migrator: { name: 'belgobeton_migrator', url: env.DATABASE_URL_MIGRATOR },
  app: { name: 'belgobeton_app', url: env.DATABASE_URL_APP },
  auth: { name: 'belgobeton_auth', url: env.DATABASE_URL_AUTH },
  system: { name: 'belgobeton_system', url: env.DATABASE_URL_SYSTEM },
} as const;

const migratorUrl = new URL(env.DATABASE_URL_MIGRATOR);
const databases = [migratorUrl.pathname.slice(1), 'belgobeton_test'];

function superuserUrl(database: string): string {
  const url = new URL(migratorUrl);
  url.username = 'postgres';
  url.password = superuserPassword;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient(database: string, fn: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: superuserUrl(database) });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

await withClient('postgres', async (client) => {
  for (const role of Object.values(ROLES)) {
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

  for (const database of databases) {
    const exists = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (!exists.rowCount) {
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(database)} OWNER ${client.escapeIdentifier(ROLES.migrator.name)}`,
      );
    }
  }
});

for (const database of databases) {
  await withClient(database, async (client) => {
    const db = client.escapeIdentifier(database);
    const runtime = [ROLES.app, ROLES.auth, ROLES.system]
      .map((r) => client.escapeIdentifier(r.name))
      .join(', ');
    // Nothing for PUBLIC: no default CONNECT or TEMP on the database.
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${db} TO ${runtime}, ${client.escapeIdentifier(ROLES.migrator.name)}`,
    );
    // The migrator owns the public schema, so migrations (not this script) decide its grants.
    await client.query(`ALTER SCHEMA public OWNER TO ${client.escapeIdentifier(ROLES.migrator.name)}`);
  });
}

console.log(`Bootstrapped roles and databases: ${databases.join(', ')}`);
