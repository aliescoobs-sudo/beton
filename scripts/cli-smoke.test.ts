import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guards for things only a real `node` / `docker compose` run notices: an entry point that no longer
// loads under plain node (e.g. a Next-only import pulled in through a module index), or a compose file that no
// longer interpolates. Needs no database and no secrets.
const NOT_ENTRY_POINTS = new Set([
  'backup-lib.ts',
  'cli-help.ts',
  'import-excel-lib.ts',
  'import-history-lib.ts',
  'ops-sandbox.ts',
  'prompt.ts',
  'training-birth.ts',
  'training-day.ts',
  'training-lib.ts',
]);
// A bare environment: no .env files, secrets or database settings leak in.
const bareEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: 'test',
};
const entryPoints = readdirSync('scripts').filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !NOT_ENTRY_POINTS.has(f),
);

describe('every CLI script loads under plain node and answers --help', () => {
  it('finds the entry points', () => {
    expect(entryPoints.length).toBeGreaterThanOrEqual(9);
  });

  it.each(entryPoints)(
    'scripts/%s --help',
    (file) => {
      const run = spawnSync(
        process.execPath,
        ['--import', './scripts/register-ts-paths.mjs', `scripts/${file}`, '--help'],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: bareEnv,
        },
      );
      expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/\S/);
    },
    60_000,
  );

  it('every package.json script that runs a script file points at an existing entry point', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    for (const command of Object.values(scripts)) {
      for (const match of command.matchAll(/scripts\/([\w-]+\.ts)/g)) {
        expect(existsSync(`scripts/${match[1]}`)).toBe(true);
      }
    }
  });
});

const hasDocker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasDocker)('docker compose and the env split', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bb-compose-'));
  const dummyOps = join(scratch, 'ops.env');
  writeFileSync(dummyOps, 'POSTGRES_SUPERUSER_PASSWORD=not-a-real-password\n');
  const compose = (...args: string[]) =>
    spawnSync('docker', ['compose', ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: bareEnv,
    });

  it('the compose file interpolates from the ops env file', () => {
    const run = compose('--env-file', dummyOps, 'config', '-q');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('without it, compose refuses and the message names .env.ops, not .env.local', () => {
    const run = compose('--env-file', '/dev/null', 'config', '-q');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('.env.ops');
    expect(run.stderr).not.toContain('.env.local');
    rmSync(scratch, { recursive: true, force: true });
  });

  it('every compose command in package.json passes --env-file .env.ops', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    const composeScripts = Object.entries(scripts).filter(([, cmd]) => cmd.includes('docker compose'));
    expect(composeScripts.length).toBeGreaterThan(0);
    for (const [, cmd] of composeScripts) expect(cmd).toContain('--env-file .env.ops');
  });
});

describe('the ops secrets stay out of files Next.js loads', () => {
  it.skipIf(!existsSync('.env.local'))(
    '.env.local defines no superuser, backup or age-identity variable',
    () => {
      expect(readFileSync('.env.local', 'utf8')).not.toMatch(
        /^\s*(POSTGRES_SUPERUSER_PASSWORD|BACKUP_AGE_IDENTITY_FILE|DATABASE_URL_BACKUP|DATABASE_URL_SEED)\s*=/m,
      );
    },
  );
});
