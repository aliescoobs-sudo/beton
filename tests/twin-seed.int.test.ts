import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedTraining } from '../scripts/seed-training';
import { seedTwin } from '../scripts/seed/twin/index';
import { testEnv } from './db-env';

// T20 (D251): the fictitious twin seed, run once on a scratch database that the training seed (profile twin-base) prepared. Fictitious data only.
const env = testEnv(TRAINING_TEST_DATABASE);
const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
migrator.on('error', () => undefined);
let first: Awaited<ReturnType<typeof seedTwin>>;
let second: Awaited<ReturnType<typeof seedTwin>>;
/** A snapshot of every table's row count: a second run must leave it exactly as it was. */
let afterFirst: Record<string, number>;
let afterSecond: Record<string, number>;

async function rowCounts(): Promise<Record<string, number>> {
  const tables = await migrator.query<{ s: string; t: string }>(
    `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'finance', 'history') order by 1, 2`,
  );
  const out: Record<string, number> = {};
  for (const { s, t } of tables.rows)
    out[`${s}.${t}`] = Number(
      (await migrator.query<{ n: string }>(`select count(*) as n from "${s}"."${t}"`)).rows[0]!.n,
    );
  return out;
}

beforeAll(async () => {
  await ensureRoles(training, env.DATABASE_URL_SEED);
  await recreateDatabase(training, TRAINING_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-twin-'));
  await seedTraining({
    provenance: 'unverified-test-database',
    profile: 'twin-base',
    env: training,
    today: '2026-11-15',
    credentialsFile: path.join(dir, 'training-accounts.local.txt'),
  });
  first = await seedTwin({ env: training, flag: 'true' });
  afterFirst = await rowCounts();
  second = await seedTwin({ env: training, flag: 'true' });
  afterSecond = await rowCounts();
}, 900_000);
afterAll(() => migrator.end());

const count = async (sql: string, params: unknown[] = []) =>
  Number((await migrator.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('the twin seed refuses (T20)', () => {
  it('without the fictitious flag, on a production-looking environment, and without the marker row', async () => {
    await expect(seedTwin({ env: training, flag: undefined })).rejects.toThrow(/TWIN_SEED_FICTITIOUS/);
    await expect(
      seedTwin({ env: { ...training, APP_ENV: 'production' as never }, flag: 'true' }),
    ).rejects.toThrow(/production/);
    await expect(seedTwin({ env: { ...training, REAL_DATA: true }, flag: 'true' })).rejects.toThrow(
      /REAL_DATA/,
    );
    await expect(
      seedTwin({
        env: {
          ...training,
          DATABASE_URL_MIGRATOR: training.DATABASE_URL_MIGRATOR.replace(
            TRAINING_TEST_DATABASE,
            'kayas_production',
          ),
        },
        flag: 'true',
      }),
    ).rejects.toThrow(/production/);
    // no marker row: the training marker is taken away for one call and put back
    await migrator.query('delete from public.training_marker');
    try {
      await expect(seedTwin({ env: training, flag: 'true' })).rejects.toThrow(/fictitious marker/);
    } finally {
      await migrator.query('insert into public.training_marker default values');
    }
  });
});

describe('item 1: the structure', () => {
  it('seeds and is idempotent: the second run changes nothing', () => {
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst['public.twin_seed_marker']).toBe(1);
  });

  it('has two plants, about 30 clients, 12 suppliers, vehicles and pumps', async () => {
    expect(await count(`select count(*) as n from plant where status = 'active'`)).toBe(2);
    expect(await count(`select count(*) as n from client where status = 'active'`)).toBe(30);
    expect(await count(`select count(*) as n from supplier where status = 'active'`)).toBe(12);
    expect(await count(`select count(*) as n from truck where kind = 'mixer'`)).toBe(9);
    expect(await count(`select count(*) as n from truck where kind = 'pump'`)).toBe(3);
  });

  it('mixes companies and private individuals, PO-required and TTC clients, aliases, names in different cases', async () => {
    expect(await count(`select count(*) as n from client where kind = 'person'`)).toBeGreaterThanOrEqual(6);
    expect(await count(`select count(*) as n from client where kind = 'company'`)).toBeGreaterThanOrEqual(20);
    expect(await count(`select count(*) as n from client where po_required`)).toBeGreaterThanOrEqual(5);
    expect(await count(`select count(*) as n from client where price_basis = 'TTC'`)).toBeGreaterThanOrEqual(
      8,
    );
    expect(await count(`select count(*) as n from client where price_basis = 'HT'`)).toBeGreaterThanOrEqual(
      15,
    );
    expect(await count(`select count(*) as n from client_alias`)).toBeGreaterThanOrEqual(5);
    expect(
      await count(
        `select count(*) as n from client where split_part(name, ' (', 1) = upper(split_part(name, ' (', 1))`,
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await count(
        `select count(*) as n from client where split_part(name, ' (', 1) = lower(split_part(name, ' (', 1))`,
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it('has the A1 recipes per class and plant', async () => {
    expect(await count(`select count(*) as n from recette where plant_id is not null`)).toBe(2);
    expect(
      await count(
        `select count(distinct concrete_type_id) as n from recette r join concrete_type t on t.id = r.concrete_type_id where t.code in ('B15','B20','B25','B30','B35')`,
      ),
    ).toBe(5);
  });
});
