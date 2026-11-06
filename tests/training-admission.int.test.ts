import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase, superuserUrl } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { assertSeedTargetEmpty, seedTraining } from '../scripts/seed-training';
import { claimBirthToken, hasBirthToken, mintBirthToken } from '../scripts/training-birth';
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
    await expect(
      seedTraining({
        provenance: 'unverified-test-database',
        env: training,
        today: '2026-11-05',
        credentialsFile: file,
      }),
    ).rejects.toThrow(/not empty/);
    expect(existsSync(file)).toBe(false);
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(0);
    expect((await migrator.query('select 1 from plant')).rowCount).toBe(0);
    expect((await migrator.query('select 1 from "user"')).rowCount).toBe(0);
    // and it stays refused: a second attempt does not "complete" it
    await expect(
      seedTraining({
        provenance: 'unverified-test-database',
        env: training,
        today: '2026-11-05',
        credentialsFile: file,
      }),
    ).rejects.toThrow(/not empty/);
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
        seedTraining({
          provenance: 'unverified-test-database',
          env: training,
          today: '2026-11-05',
          credentialsFile: bad,
        }),
      ).rejects.toThrow(/refused/);
    const dir = folder(0o700);
    symlinkSync('/etc/hosts', path.join(dir, 'training-accounts.local.txt'));
    await expect(
      seedTraining({
        provenance: 'unverified-test-database',
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
          provenance: 'unverified-test-database',
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
        provenance: 'unverified-test-database',
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
    const r = await seedTraining({
      provenance: 'unverified-test-database',
      env: training,
      today: '2026-11-05',
      credentialsFile: file,
    });
    expect(r.applied).toBe(true);
    expect(readdirSync(dir)).toEqual(['training-accounts.local.txt']);
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(1);
  }, 600_000);
});

describe('seed admission looks at all business state (R12-01)', () => {
  const asSuper = async (sql: string) => {
    const c = new pg.Client({ connectionString: superuserUrl(training, TRAINING_TEST_DATABASE) });
    await c.connect();
    try {
      await c.query(
        `select set_config('app.user_id', '${SYSTEM_ACTOR_ID}', false), set_config('app.role', 'system', false)`,
      );
      await c.query(`set session_replication_role = replica`); // the row guards of finance are not what is under test
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  const fresh = async () => {
    await recreateDatabase(training, TRAINING_TEST_DATABASE);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
  };
  it('a freshly migrated database passes: migrations leave no row anywhere in public or finance', async () => {
    await fresh();
    await expect(assertSeedTargetEmpty(migrator)).resolves.toBeUndefined();
  });
  it('a row in a finance table alone is refused, naming the table and no content', async () => {
    await fresh();
    await asSuper(
      `insert into finance.finance_category (id, code, label, nature, kind, created_by)
       values (gen_random_uuid(), 'SECRETCODE', 'Libellé réel', 'fixed', 'expense', '${SYSTEM_ACTOR_ID}')`,
    );
    const refusal = assertSeedTargetEmpty(migrator);
    await expect(refusal).rejects.toThrow(/finance\.finance_category/);
    await expect(refusal).rejects.not.toThrow(/SECRETCODE|Libellé/);
    await expect(
      seedTraining({
        provenance: 'unverified-test-database',
        env: training,
        today: '2026-11-06',
        credentialsFile: file,
      }),
    ).rejects.toThrow(/not empty/);
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(0);
  });
  it('a table the maintenance login cannot read (row-level security) is still caught', async () => {
    await fresh();
    await asSuper(`insert into code_sequence (key, last_value) values ('ZZZ', 5)`);
    expect((await migrator.query('select 1 from code_sequence')).rowCount).toBe(0); // invisible to a plain read
    await expect(assertSeedTargetEmpty(migrator)).rejects.toThrow(/public\.code_sequence/);
  });
  it('R13-01: a table holding only RLS-hidden rows is refused at once, whatever the statistics say (fail closed, no wait)', async () => {
    await fresh();
    await asSuper(`insert into code_sequence (key, last_value) values ('QQQ', 9)`);
    await asSuper(`analyze public.code_sequence`); // statistics are not what decides, in either direction
    await expect(assertSeedTargetEmpty(migrator)).rejects.toThrow(/cannot be proven|hold rows/);
    await asSuper(`select pg_stat_reset()`); // the statistics are gone (as after a crash): still refused
    const refusal = assertSeedTargetEmpty(migrator);
    await expect(refusal).rejects.toThrow(/public\.code_sequence/);
    await expect(refusal).rejects.not.toThrow(/QQQ/);
  });
  it('R13-01: a table written to and emptied again cannot be proven empty under row-level security: refused, not read as zero', async () => {
    await fresh();
    await asSuper(`insert into code_sequence (key, last_value) values ('DEL', 1)`);
    await asSuper(`delete from code_sequence`);
    await expect(assertSeedTargetEmpty(migrator)).rejects.toThrow(/cannot be proven/);
  });
  it('lists the tables from the catalog: a table created later is covered without editing a list', async () => {
    await fresh();
    await asSuper(`create table public.t4_future_table (id int)`);
    await asSuper(`insert into public.t4_future_table values (1)`);
    await expect(assertSeedTargetEmpty(migrator)).rejects.toThrow(/public\.t4_future_table/);
  });
});

// R13-01: provenance. The stock stack's initialisation step writes one birth token on the first creation of the volume.
describe('seed provenance: the birth token (R13-01)', () => {
  const superClient = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: superuserUrl(training, 'postgres') });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const initSql = readFileSync(
    path.join(process.cwd(), 'scripts/training/db-init/10-birth-token.sql'),
    'utf8',
  );
  /** What the postgres image does once, on a brand new volume. */
  const bornFresh = () =>
    superClient(async (c) => {
      await c.query('drop table if exists public.volume_birth');
      await c.query(initSql);
    });
  const noToken = () => superClient((c) => c.query('drop table if exists public.volume_birth'));
  afterAll(noToken);
  const fresh = async () => {
    await recreateDatabase(training, TRAINING_TEST_DATABASE);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
  };
  const out = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'bb-birth-'));
    chmodSync(d, 0o700);
    return path.join(d, 'training-accounts.local.txt');
  };
  it('a database restored (or built) on a cluster without the token is refused, nothing written', async () => {
    await noToken();
    await fresh(); // empty, migrated: the same as the target of a restore before the data arrive
    const f = out();
    await expect(seedTraining({ env: training, today: '2026-11-06', credentialsFile: f })).rejects.toThrow(
      /not born fresh/,
    );
    expect(existsSync(f)).toBe(false);
    expect((await migrator.query('select 1 from "user"')).rowCount).toBe(0);
    expect((await migrator.query('select 1 from public.training_marker')).rowCount).toBe(0);
  });
  it('a fresh stock volume is admitted once: the seed consumes the token, a second seed on that volume is refused', async () => {
    await bornFresh();
    await fresh();
    const f = out();
    const r = await seedTraining({ env: training, today: '2026-11-06', credentialsFile: f });
    expect(r.applied).toBe(true);
    expect(await hasBirthToken(training)).toBe(false);
    // the volume is spent: a new empty database on it is refused (a seed is not repeated on a volume; reset:training mints a new token)
    await fresh();
    await expect(
      seedTraining({ env: training, today: '2026-11-06', credentialsFile: out() }),
    ).rejects.toThrow(/not born fresh/);
  }, 600_000);
  it('the token is claimed atomically: of two concurrent claims only one wins', async () => {
    await bornFresh();
    const wins = await Promise.all([
      claimBirthToken(training),
      claimBirthToken(training),
      claimBirthToken(training),
    ]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
  it('the skip is for the test-runner databases only', async () => {
    const live = {
      ...training,
      DATABASE_URL_MIGRATOR: training.DATABASE_URL_MIGRATOR.replace(/\/[^/]+$/, '/belgobeton'),
    };
    await expect(
      seedTraining({
        provenance: 'unverified-test-database',
        env: live,
        today: '2026-11-06',
        credentialsFile: out(),
      }),
    ).rejects.toThrow(/can only be skipped/);
  });
  it('a reset mints a new token after dropping a marked training database', async () => {
    await noToken();
    await mintBirthToken(training);
    expect(await hasBirthToken(training)).toBe(true);
  });
});
