import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/lib/env';
import { historyEnvironmentProblem } from '../src/modules/importer/history/domain/guard';
import { ImportRefused, purgeStaging, rollbackHistory, runHistory } from '../src/modules/importer';
import { stagingConfig } from './ops-sandbox';

// T10g group D (R19B-03, containment for the VPS staging): the server-side history import is DISABLED when STAGING_PROFILE=true, at the environment, in the
// guard, in the service (every mode, before any I/O) and in the CLI (before an argument is read), and no importer mount can exist in the staging stack.
const base = {
  NODE_ENV: 'production',
  DATABASE_URL_APP: 'postgres://app:pw@db:5432/belgobeton',
  DATABASE_URL_MIGRATOR: 'postgres://migrator:pw@db:5432/belgobeton',
  DATABASE_URL_AUTH: 'postgres://auth:pw@db:5432/belgobeton',
  DATABASE_URL_SYSTEM: 'postgres://system:pw@db:5432/belgobeton',
  AUTH_SECRET: 'a'.repeat(32),
  FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  RECOVERY_CODES_KEYS: `r1:${Buffer.alloc(32, 8).toString('base64')}`,
  LOOKUP_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
  APP_BASE_URL: 'https://kayas.example.com',
  BACKUP_AGE_RECIPIENT: 'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq',
};
const staging = {
  ...base,
  APP_ENV: 'training',
  TRAINING_MODE: 'true',
  REAL_DATA: 'false',
  STAGING_PROFILE: 'true',
};

describe('the STAGING_PROFILE flag', () => {
  it('is accepted only on a training instance with fictitious data', () => {
    expect(loadEnv(staging).STAGING_PROFILE).toBe(true);
    expect(loadEnv({ ...staging, STAGING_PROFILE: undefined }).STAGING_PROFILE).toBe(false);
    for (const bad of [
      { ...staging, TRAINING_MODE: 'false' },
      { ...staging, TRAINING_MODE: undefined },
      { ...staging, REAL_DATA: 'true' },
      { ...staging, APP_ENV: 'production' },
    ])
      expect(() => loadEnv(bad)).toThrow(/STAGING_PROFILE|TRAINING_MODE/);
  });
});

describe('the guard and the service refuse every mode on the staging profile', () => {
  const env = { trainingMode: true, realData: false, simulationEnabled: false, stagingProfile: true };
  it('the environment guard says so first, even for an unmarked-looking or marked twin file', () => {
    for (const files of [
      [],
      [{ marked: true, names: [], expenseLabels: [] }],
      [{ marked: false, names: ['A FICTIF'], expenseLabels: [] }],
    ])
      expect(historyEnvironmentProblem(env, true, files)).toMatch(/DISABLED on the staging profile/);
    expect(historyEnvironmentProblem({ ...env, stagingProfile: false }, true, []) ?? '').not.toMatch(
      /DISABLED on the staging profile/,
    );
  });
  // a pool that fails the test if anything touches it, and a folder that does not exist: the refusal comes before any read or query
  const pool = new Proxy(
    {},
    {
      get: () => {
        throw new Error('the database was touched');
      },
    },
  ) as never;
  const actor = { id: 'x', role: 'owner', stepUpVerified: true } as never;
  it('runHistory (dry-run, stage, apply), rollback and the purge are refused before any file is read or any query is made', async () => {
    for (const mode of ['dry-run', 'stage', 'apply'] as const) {
      const err = await runHistory({
        mode,
        files: ['/nonexistent/twin.xlsx'],
        mapping: {} as never,
        appPool: pool,
        actor,
        environment: env,
      } as never).catch((e) => e);
      expect(err, mode).toBeInstanceOf(ImportRefused);
      expect((err as ImportRefused).message, mode).toMatch(/DISABLED on the staging profile/);
    }
    const rb = await rollbackHistory({
      appPool: pool,
      actor,
      batchId: '00000000-0000-4000-8000-000000000000',
      environment: env,
    }).catch((e) => e);
    expect(rb).toBeInstanceOf(ImportRefused);
    const pg = await purgeStaging({ appPool: pool, actor, environment: env }).catch((e) => e);
    expect(pg).toBeInstanceOf(ImportRefused);
  });
});

describe('the CLI refuses before it reads an argument, opens a file or connects', () => {
  const run = (args: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-sp-'));
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        './scripts/register-ts-paths.mjs',
        'scripts/import-history.ts',
        ...args.map((a) => a.replace('<dir>', dir)),
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          NODE_ENV: 'production',
          APP_ENV: 'training',
          TRAINING_MODE: 'true',
          REAL_DATA: 'false',
          STAGING_PROFILE: 'true',
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    return { ...r, dir };
  };
  for (const args of [
    ['--dry-run', '<dir>/nope', '--mapping', '<dir>/m.json'],
    ['--stage', '<dir>/nope', '--mapping', '<dir>/m.json'],
    ['--apply', '<dir>/nope', '--mapping', '<dir>/m.json'],
    ['--rollback', '<dir>'],
    ['--purge-staging', '--account', 'a@b.c'],
    ['--init-mapping', '<dir>/maps'],
  ])
    it(`refuses: ${args[0]}`, () => {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/DISABLED on the staging profile/);
      expect(existsSync(path.join(r.dir, 'maps'))).toBe(false); // not even a mapping file is written
      expect(r.stderr).not.toMatch(/ECONNREFUSED|ENOTFOUND|password/i); // no connection was attempted
    });
});

describe('no importer mount can exist in the staging stack', () => {
  it('the compose file and the wrappers have no host folder for an importer, and the validator refuses one', () => {
    const compose = readFileSync('docker-compose.staging.yml', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const sources = [...compose.matchAll(/^\s*- (\.\/[^:\s]+):/gm)].map((m) => m[1]);
    expect(sources.sort()).toEqual([
      './Caddyfile.staging',
      './scripts/training/db-init',
      './staging', // the Basic Auth hash directory, read-only (decision 228); it holds no import data
    ]);
    expect(compose).not.toMatch(/\/twin|imports|import-work|OPS_TWIN|history/);
    expect(readFileSync('scripts/staging/ops.sh', 'utf8')).toMatch(
      /OPS_TWIN_DIR is not supported on staging/,
    );
    const cfg = stagingConfig();
    cfg.services.ops.volumes = [{ type: 'bind', source: '/home/ali', target: '/twin', read_only: true }];
    const r = spawnSync(
      'python3',
      [
        '-I',
        'scripts/ops/validate-compose.py',
        '--stack',
        'staging',
        '--image',
        `ghcr.io/aliescoobs-sudo/kayas@sha256:${'a1'.repeat(32)}`,
      ],
      { input: JSON.stringify(cfg), encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ops: bind mount to \/twin is not allowed/);
  });
});
