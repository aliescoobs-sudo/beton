import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, runMigrations } from '../scripts/db-migrate';
import { testEnv } from './db-env';

const env = testEnv();

async function appliedCount(): Promise<number> {
  const client = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
  await client.connect();
  try {
    const { rows } = await client.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    return rows[0].n;
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  it('are idempotent: running them again on a migrated database changes nothing', async () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'));
    expect(await appliedCount()).toBe(journal.entries.length);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    expect(await appliedCount()).toBe(journal.entries.length);
  });
});
