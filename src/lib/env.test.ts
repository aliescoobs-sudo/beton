import { describe, expect, it } from 'vitest';
import { loadBackupUrl, loadEnv, SECRET_ENV_NAMES, secretValuesOf } from './env';

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

describe('TRUSTED_PROXY_HOPS', () => {
  it('defaults to 0 (X-Forwarded-For ignored)', () => {
    expect(loadEnv(valid).TRUSTED_PROXY_HOPS).toBe(0);
  });

  it('accepts a small whole number and rejects anything else', () => {
    expect(loadEnv({ ...valid, TRUSTED_PROXY_HOPS: '1' }).TRUSTED_PROXY_HOPS).toBe(1);
    for (const bad of ['-1', '1.5', 'x', '9']) {
      expect(() => loadEnv({ ...valid, TRUSTED_PROXY_HOPS: bad })).toThrow('TRUSTED_PROXY_HOPS');
    }
  });
});

describe('loadEnv', () => {
  it('returns typed values with safe defaults for the flags', () => {
    const env = loadEnv(valid);
    expect(env.DATABASE_URL_APP).toBe(valid.DATABASE_URL_APP);
    expect(env.SIMULATION_ENABLED).toBe(false);
    expect(env.REAL_DATA).toBe(false);
  });

  it('fails listing every missing variable by name', () => {
    const partial: Record<string, string | undefined> = { ...valid };
    delete partial.AUTH_SECRET;
    delete partial.DATABASE_URL_APP;
    let message = '';
    try {
      loadEnv(partial);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('AUTH_SECRET');
    expect(message).toContain('DATABASE_URL_APP');
  });

  it('never echoes a secret value in its error', () => {
    const tooShort = 'short-secret-value';
    let message = '';
    try {
      loadEnv({ ...valid, AUTH_SECRET: tooShort });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('AUTH_SECRET');
    expect(message).not.toContain(tooShort);
  });

  it('rejects a keyring whose key is not 32 bytes', () => {
    expect(() =>
      loadEnv({ ...valid, FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(16).toString('base64')}` }),
    ).toThrow(/FIELD_ENCRYPTION_KEYS/);
  });

  it('parses boolean flags strictly', () => {
    expect(loadEnv({ ...valid, SIMULATION_ENABLED: 'true' }).SIMULATION_ENABLED).toBe(true);
    expect(() => loadEnv({ ...valid, REAL_DATA: 'yes' })).toThrow(/REAL_DATA/);
  });
});

describe('backup credentials stay out of the app environment', () => {
  it('the app environment neither requires nor exposes DATABASE_URL_BACKUP', () => {
    const env = loadEnv({
      ...valid,
      DATABASE_URL_BACKUP: 'postgres://belgobeton_backup:pw@localhost:5432/belgobeton',
    });
    expect(env).not.toHaveProperty('DATABASE_URL_BACKUP');
  });

  it('the backup job reads it on its own', () => {
    expect(
      loadBackupUrl({ DATABASE_URL_BACKUP: 'postgres://belgobeton_backup:pw@localhost:5432/x' }),
    ).toMatch(/^postgres:/);
    expect(() => loadBackupUrl({})).toThrow(/DATABASE_URL_BACKUP/);
  });
});

describe('secretValuesOf', () => {
  it('returns the value of every secret variable, for log scrubbing', () => {
    const env = loadEnv(valid);
    const secrets = secretValuesOf(env);
    for (const name of SECRET_ENV_NAMES) expect(secrets).toContain(env[name]);
  });

  it('also returns each key of a keyring on its own', () => {
    const env = loadEnv(valid);
    expect(secretValuesOf(env)).toContain(Buffer.alloc(32, 7).toString('base64'));
    expect(secretValuesOf(env)).toContain(Buffer.alloc(32, 8).toString('base64'));
  });

  it('also returns database passwords on their own', () => {
    const env = loadEnv({
      ...valid,
      DATABASE_URL_APP: 'postgres://app:s3cr3t-db-pw@localhost:5432/belgobeton',
    });
    expect(secretValuesOf(env)).toContain('s3cr3t-db-pw');
  });
});

describe('simulation guard (AC-CLK-02)', () => {
  it('accepts simulation in development and test', () => {
    expect(loadEnv({ ...valid, SIMULATION_ENABLED: 'true' }).SIMULATION_ENABLED).toBe(true);
    expect(loadEnv({ ...valid, NODE_ENV: 'test', SIMULATION_ENABLED: 'true' }).SIMULATION_ENABLED).toBe(true);
  });

  it('refuses simulation with NODE_ENV=production', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', SIMULATION_ENABLED: 'true' })).toThrow(
      /SIMULATION_ENABLED/,
    );
  });

  it('refuses simulation with REAL_DATA=true', () => {
    expect(() => loadEnv({ ...valid, REAL_DATA: 'true', SIMULATION_ENABLED: 'true' })).toThrow(
      /SIMULATION_ENABLED/,
    );
  });

  it('still allows production with simulation off', () => {
    expect(loadEnv({ ...valid, NODE_ENV: 'production' }).SIMULATION_ENABLED).toBe(false);
  });
});
