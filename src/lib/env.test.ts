import { describe, expect, it } from 'vitest';
import {
  loadBackupUrl,
  loadEnv,
  loadSeedUrl,
  seedRoleAllowed,
  parseAuthSecrets,
  SECRET_ENV_NAMES,
  secretValuesOf,
} from './env';

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

describe('AUTH_SECRETS', () => {
  it('is optional: version 1 is AUTH_SECRET', () => {
    expect(parseAuthSecrets(valid)).toEqual([{ version: 1, value: valid.AUTH_SECRET }]);
  });

  it('parses versioned secrets, current first', () => {
    const b = 'b'.repeat(32);
    expect(parseAuthSecrets({ ...valid, AUTH_SECRETS: `2:${b},1:${valid.AUTH_SECRET}` })).toEqual([
      { version: 2, value: b },
      { version: 1, value: valid.AUTH_SECRET },
    ]);
  });

  it.each(['x', '1:short', `1:${'a'.repeat(32)},1:${'b'.repeat(32)}`, `-1:${'a'.repeat(32)}`])(
    'rejects %s without echoing secrets',
    (bad) => {
      let message = '';
      try {
        loadEnv({ ...valid, AUTH_SECRETS: bad });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('AUTH_SECRETS');
      expect(message).not.toContain('a'.repeat(32));
    },
  );

  it('scrubs every version from logs', () => {
    const b = 'b'.repeat(32);
    expect(secretValuesOf(loadEnv({ ...valid, AUTH_SECRETS: `2:${b},1:${valid.AUTH_SECRET}` }))).toContain(b);
  });
});

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

describe('the seed role is simulation only', () => {
  const seed = 'postgres://belgobeton_seed:pw@localhost:5432/belgobeton';
  const sim = { SIMULATION_ENABLED: 'true', NODE_ENV: 'development', DATABASE_URL_SEED: seed };

  it('is allowed only with SIMULATION_ENABLED=true, no REAL_DATA, no production', () => {
    expect(seedRoleAllowed(sim)).toBe(true);
    expect(seedRoleAllowed({ ...sim, SIMULATION_ENABLED: 'false' })).toBe(false);
    expect(seedRoleAllowed({ ...sim, SIMULATION_ENABLED: undefined })).toBe(false);
    expect(seedRoleAllowed({ ...sim, REAL_DATA: 'true' })).toBe(false);
    expect(seedRoleAllowed({ ...sim, NODE_ENV: 'production' })).toBe(false);
  });

  it('loadSeedUrl returns the URL in simulation and refuses everywhere else', () => {
    expect(loadSeedUrl(sim)).toBe(seed);
    expect(() => loadSeedUrl({ ...sim, REAL_DATA: 'true' })).toThrow(/refused/);
    expect(() => loadSeedUrl({ ...sim, NODE_ENV: 'production' })).toThrow(/refused/);
    expect(() => loadSeedUrl({ ...sim, DATABASE_URL_SEED: undefined })).toThrow(/DATABASE_URL_SEED/);
  });

  it('the app environment neither requires nor exposes DATABASE_URL_SEED', () => {
    expect(loadEnv({ ...valid, DATABASE_URL_SEED: seed })).not.toHaveProperty('DATABASE_URL_SEED');
  });
});

describe('the assistant switches (AC-ASSIST-02, 26)', () => {
  it('are off and fake by default, with no key', () => {
    const env = loadEnv(valid);
    expect(env.ASSISTANT_ENABLED).toBe(false);
    expect(env.ASSISTANT_PROVIDER).toBe('fake');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('accept the flag on in development and test, with the fake provider', () => {
    expect(loadEnv({ ...valid, ASSISTANT_ENABLED: 'true' }).ASSISTANT_ENABLED).toBe(true);
    expect(loadEnv({ ...valid, NODE_ENV: 'test', ASSISTANT_ENABLED: 'true' }).ASSISTANT_ENABLED).toBe(true);
  });

  it('refuse the flag next to real data or in production', () => {
    expect(() => loadEnv({ ...valid, ASSISTANT_ENABLED: 'true', REAL_DATA: 'true' })).toThrow(
      /ASSISTANT_ENABLED/,
    );
    expect(() => loadEnv({ ...valid, ASSISTANT_ENABLED: 'true', NODE_ENV: 'production' })).toThrow(/CNDP/);
  });

  it('refuse the real provider and any key next to real data or in production', () => {
    const key = 'sk-ant-test-0123456789abcdefghijklmnop';
    expect(() => loadEnv({ ...valid, ASSISTANT_PROVIDER: 'anthropic', REAL_DATA: 'true' })).toThrow(
      /ASSISTANT_PROVIDER/,
    );
    expect(() => loadEnv({ ...valid, ASSISTANT_PROVIDER: 'anthropic', NODE_ENV: 'production' })).toThrow(
      /ASSISTANT_PROVIDER/,
    );
    expect(() => loadEnv({ ...valid, ANTHROPIC_API_KEY: key, NODE_ENV: 'production' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    try {
      loadEnv({ ...valid, ANTHROPIC_API_KEY: key, REAL_DATA: 'true' });
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });

  it('need a key for the real provider once the flag is on', () => {
    expect(() => loadEnv({ ...valid, ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    const key = 'sk-ant-test-0123456789abcdefghijklmnop';
    const env = loadEnv({
      ...valid,
      ASSISTANT_ENABLED: 'true',
      ASSISTANT_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: key,
    });
    expect(secretValuesOf(env)).toContain(key);
  });

  it('read an empty key as no key', () => {
    expect(loadEnv({ ...valid, ANTHROPIC_API_KEY: '  ' }).ANTHROPIC_API_KEY).toBeUndefined();
  });
});
