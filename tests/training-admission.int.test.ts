import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, symlinkSync } from 'node:fs';
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
// Recreating the database drops it under this pool's idle connections: expected, the pool reconnects.
migrator.on('error', () => undefined);
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

describe('credentials output (R11-04)', () => {
  const fresh = async () => {
    await recreateDatabase(training, TRAINING_TEST_DATABASE);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
  };
  const folder = (mode: number) => {
    const d = mkdtempSync(path.join(tmpdir(), 'bb-cred-'));
    chmodSync(d, mode);
    return d;
  };
  it('refuses an untrustworthy destination before the first write: wrong name, shared folder, symlink', async () => {
    await fresh();
    const shared = folder(0o777);
    for (const bad of [
      path.join(shared, 'training-accounts.local.txt'),
      path.join(folder(0o700), 'accounts.txt'),
      path.join(folder(0o700), 'nested', 'training-accounts.local.txt'),
    ])
      await expect(
        seedTraining({ env: training, today: '2026-11-05', credentialsFile: bad }),
      ).rejects.toThrow(/refused/);
    const dir = folder(0o700);
    symlinkSync('/etc/hosts', path.join(dir, 'training-accounts.local.txt'));
    await expect(
      seedTraining({
        env: training,
        today: '2026-11-05',
        credentialsFile: path.join(dir, 'training-accounts.local.txt'),
      }),
    ).rejects.toThrow(/regular file/);
    expect((await migrator.query('select 1 from plant')).rowCount).toBe(0);
    expect((await migrator.query('select 1 from "user"')).rowCount).toBe(0);
  });
  it('a credentials write that fails at the end stops the seed with no marker and says so', async () => {
    await fresh();
    const dir = folder(0o500); // passes the folder check, but nothing can be created in it
    try {
      await expect(
        seedTraining({
          env: training,
          today: '2026-11-05',
          credentialsFile: path.join(dir, 'training-accounts.local.txt'),
        }),
      ).rejects.toThrow(/NOT completed/);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    // the half-seeded database is refused from now on (R11-02)
    const ok = folder(0o700);
    await expect(
      seedTraining({
        env: training,
        today: '2026-11-05',
        credentialsFile: path.join(ok, 'training-accounts.local.txt'),
      }),
    ).rejects.toThrow(/not empty/);
  }, 600_000);
  it('a good run leaves one private file, no temporary file, and the marker', async () => {
    await fresh();
    const dir = folder(0o700);
    const file = path.join(dir, 'training-accounts.local.txt');
    const r = await seedTraining({ env: training, today: '2026-11-05', credentialsFile: file });
    expect(r.applied).toBe(true);
    expect(readdirSync(dir)).toEqual(['training-accounts.local.txt']);
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(1);
  }, 600_000);
});
