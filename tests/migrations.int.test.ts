import { readFileSync, readdirSync } from 'node:fs';
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

  // C1: Drizzle skips any migration whose timestamp is not above the last applied one, so a merged branch could silently never run
  // on an upgraded database. The journal must be strictly increasing and match the SQL files one to one.
  it('keep a strictly increasing journal that matches the SQL files, finance at 0200 and above', () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, i) => i === 0 || w > (whens[i - 1] as number))).toBe(true);
    const files = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files);
    for (const e of journal.entries) {
      expect(e.tag.startsWith(String(e.idx).padStart(4, '0'))).toBe(true);
      if (e.tag.includes('_finance_')) expect(e.idx).toBeGreaterThanOrEqual(200);
    }
  });
});
