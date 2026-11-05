import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase, superuserUrl } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedTraining } from '../scripts/seed-training';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';

// R11-02: the training seed refuses a database that is not empty and unmarked, before any write, and never marks it.
const env = testEnv(TRAINING_TEST_DATABASE);
const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
const dir = mkdtempSync(path.join(tmpdir(), 'bb-admission-'));
const file = path.join(dir, 'training-accounts.local.txt');
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
afterAll(() => migrator.end());

beforeAll(async () => {
  await ensureRoles(training, env.DATABASE_URL_SEED);
  await recreateDatabase(training, TRAINING_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
}, 300_000);

describe('seed admission (R11-02)', () => {
  it('refuses an unmarked database that already holds business records, writes nothing, leaves no marker', async () => {
    const c = new pg.Client({ connectionString: superuserUrl(training, TRAINING_TEST_DATABASE) });
    await c.connect();
    try {
      await c.query(
        `select set_config('app.user_id', '${SYSTEM_ACTOR_ID}', false), set_config('app.role', 'system', false)`,
      );
      await c.query(
        `insert into client (id, code, name, kind) values (gen_random_uuid(), 'CLT-9999', 'Un vrai client', 'company')`,
      );
    } finally {
      await c.end();
    }
    await expect(seedTraining({ env: training, today: '2026-11-05', credentialsFile: file })).rejects.toThrow(
      /not empty/,
    );
    expect(existsSync(file)).toBe(false);
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(0);
    expect((await migrator.query('select 1 from plant')).rowCount).toBe(0);
    expect((await migrator.query('select 1 from "user"')).rowCount).toBe(0);
    // and it stays refused: a second attempt does not "complete" it
    await expect(seedTraining({ env: training, today: '2026-11-05', credentialsFile: file })).rejects.toThrow(
      /not empty/,
    );
  });
});
