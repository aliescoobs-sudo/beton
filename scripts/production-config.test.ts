import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/lib/env';
import { seedPilotMasterData } from '../src/modules/master-data/service/pilot-seed';
import { GET as live } from '../src/app/api/health/live/route';

// R9 (CP-PROD-PLAN): AC-PROD-27, 29, 31, 32. The production files are read as text; a change that exposes the database, bakes a
// secret into the image or hands the server a key to the office copy fails here.
const compose = readFileSync('docker-compose.prod.yml', 'utf8');
const serviceBlock = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n|\n[a-z]+:/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe('the production stack (AC-PROD-29)', () => {
  it('publishes no database port, and the database is on the internal network only', () => {
    const db = serviceBlock('db');
    expect(db).not.toMatch(/\bports:/);
    expect(db).toMatch(/networks:\s*\[internal\]/);
    expect(compose).toMatch(/internal:\s*\n\s+internal:\s*true/);
  });
  it('only the reverse proxy publishes ports', () => {
    for (const name of ['db', 'app', 'ops']) expect(serviceBlock(name), name).not.toMatch(/\bports:/);
    expect(serviceBlock('proxy')).toMatch(/- '80:80'/);
    expect(serviceBlock('proxy')).toMatch(/- '443:443'/);
    expect((compose.match(/\bports:/g) ?? []).length).toBe(1);
  });
  it('runs real data, with simulation off and one trusted proxy hop', () => {
    const app = serviceBlock('app');
    expect(app).toMatch(/REAL_DATA: 'true'/);
    expect(app).toMatch(/SIMULATION_ENABLED: 'false'/);
    expect(app).toMatch(/TRUSTED_PROXY_HOPS: '1'/);
  });
  it('carries no secret value: every secret comes from an env file or a required variable', () => {
    expect(compose).not.toMatch(/^\s+\w*PASSWORD:\s*[^$\s'"]/m);
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_SUPERUSER_PASSWORD:\?/);
    expect(compose).not.toMatch(/AGE-SECRET-KEY|BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
  });
  it('the image runs as a non-root user with a health check and no secret baked in', () => {
    const docker = readFileSync('Dockerfile', 'utf8');
    expect(docker).toMatch(/^USER 10001:10001$/m);
    expect(docker).toMatch(/^HEALTHCHECK /m);
    expect(docker).not.toMatch(/^ENV .*(PASSWORD|SECRET|KEY)=/m);
    expect(docker).toMatch(/SIMULATION_ENABLED=false/);
    expect(readFileSync('.dockerignore', 'utf8')).toMatch(/^\.env$/m);
  });
});

describe('the backup copy to the office machine (AC-PROD-31, C2)', () => {
  const pull = readFileSync('scripts/ops/backup-pull.sh', 'utf8');
  const nightly = readFileSync('scripts/ops/backup-nightly.sh', 'utf8');
  it('is pulled from the office machine, with its own key, staged and verified before it reaches the store', () => {
    expect(pull).toMatch(/^set -euo pipefail$/m);
    expect(pull).toMatch(/rsync /);
    expect(pull).toContain('"$SERVER:$REMOTE_DIR/"');
    expect(pull).toMatch(/BatchMode=yes/);
    expect(pull).toMatch(/backup-verify\.ts ingest/);
    expect(pull).toMatch(/MAX_AGE_HOURS/);
    expect(pull).toMatch(/alert\.sh/);
    expect(pull).not.toMatch(/--ignore-existing/);
  });
  it('the server scripts never touch the age private key, the signing key, nor any key to the office machine', () => {
    for (const script of [pull, nightly]) {
      expect(script).not.toMatch(/AGE-SECRET-KEY|BACKUP_AGE_IDENTITY|PRIVATE KEY/);
    }
    expect(nightly).not.toMatch(/SIGNING_KEY_FILE/);
    expect(nightly).toMatch(/^set -euo pipefail$/m);
    expect(nightly).not.toMatch(/\bscp\b|\brsync\b|\bssh\b/);
    expect(nightly).toMatch(/alert\.sh/);
  });
});
describe('real data mode (AC-PROD-27)', () => {
  const valid = {
    NODE_ENV: 'development',
    DATABASE_URL_APP: 'postgres://app:pw@localhost:5432/belgobeton',
    DATABASE_URL_MIGRATOR: 'postgres://migrator:pw@localhost:5432/belgobeton',
    DATABASE_URL_AUTH: 'postgres://auth:pw@localhost:5432/belgobeton',
    DATABASE_URL_SYSTEM: 'postgres://system:pw@localhost:5432/belgobeton',
    AUTH_SECRET: 'a'.repeat(32),
    FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    RECOVERY_CODES_KEYS: `r1:${Buffer.alloc(32, 8).toString('base64')}`,
    LOOKUP_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
    APP_BASE_URL: 'http://localhost:3000',
    BACKUP_AGE_RECIPIENT: 'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq',
  };
  it('refuses simulation, the pilot seed and the AI features with REAL_DATA=true', () => {
    expect(() => loadEnv({ ...valid, REAL_DATA: 'true', SIMULATION_ENABLED: 'true' } as never)).toThrow(
      /SIMULATION_ENABLED/,
    );
    expect(() => loadEnv({ ...valid, REAL_DATA: 'true', ASSISTANT_ENABLED: 'true' } as never)).toThrow(
      /ASSISTANT_ENABLED/,
    );
    expect(() => loadEnv({ ...valid, REAL_DATA: 'true', AI_EXTRACTION_ENABLED: 'true' } as never)).toThrow(
      /AI_EXTRACTION_ENABLED/,
    );
  });
  it('the pilot seed refuses to run on real data', async () => {
    await expect(
      seedPilotMasterData(
        {} as never,
        { SIMULATION_ENABLED: true, REAL_DATA: true, NODE_ENV: 'production' } as never,
      ),
    ).rejects.toThrow(/REAL_DATA/);
  });
});

describe('health checks (AC-PROD-32)', () => {
  it('liveness answers with a status word and nothing else', async () => {
    const res = live();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
  it('readiness reveals no version, count, host or error text', () => {
    const src = readFileSync('src/app/api/health/ready/route.ts', 'utf8');
    expect(src).not.toMatch(/error\.message|version|process\.env|hostname/);
    expect(src.match(/status: '[a-z_]+' \}/g)?.length).toBe(3);
  });
});
