import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { funnelWarning, isTrainingEmail, trainingBootProblem } from './training';

const valid = {
  DATABASE_URL_APP: 'postgres://app:pw@db:5432/belgobeton',
  DATABASE_URL_AUTH: 'postgres://auth:pw@db:5432/belgobeton',
  DATABASE_URL_SYSTEM: 'postgres://system:pw@db:5432/belgobeton',
  AUTH_SECRET: 'a'.repeat(32),
  FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  RECOVERY_CODES_KEYS: `r1:${Buffer.alloc(32, 8).toString('base64')}`,
  LOOKUP_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
  APP_BASE_URL: 'https://beton.example.test',
  BACKUP_AGE_RECIPIENT: 'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq',
};

describe('TRAINING_MODE in the environment (T1)', () => {
  it('is off by default and accepted for the training deployment', () => {
    expect(loadEnv(valid).TRAINING_MODE).toBe(false);
    expect(
      loadEnv({ ...valid, TRAINING_MODE: 'true', APP_ENV: 'training', NODE_ENV: 'production' }).TRAINING_MODE,
    ).toBe(true);
  });
  it('is refused with APP_ENV=production and with REAL_DATA=true', () => {
    expect(() => loadEnv({ ...valid, TRAINING_MODE: 'true', APP_ENV: 'production' })).toThrow(
      /TRAINING_MODE/,
    );
    expect(() => loadEnv({ ...valid, TRAINING_MODE: 'true', REAL_DATA: 'true' })).toThrow(/TRAINING_MODE/);
  });
  it('the production environment is untouched by the training variables being absent', () => {
    expect(() =>
      loadEnv({ ...valid, APP_ENV: 'production', NODE_ENV: 'production', REAL_DATA: 'true' }),
    ).not.toThrow();
  });
});

describe('the boot rule (T1)', () => {
  it('refuses training mode in production, and a seeded database without the flag', () => {
    expect(trainingBootProblem({ trainingMode: true, appEnv: 'production', databaseSeeded: false })).toMatch(
      /APP_ENV=production/,
    );
    expect(trainingBootProblem({ trainingMode: false, appEnv: 'production', databaseSeeded: true })).toMatch(
      /training seed/,
    );
    expect(trainingBootProblem({ trainingMode: false, appEnv: undefined, databaseSeeded: true })).toMatch(
      /TRAINING_MODE is not "true"/,
    );
  });
  it('lets through the training server on its database, and any server on a clean database', () => {
    expect(trainingBootProblem({ trainingMode: true, appEnv: 'training', databaseSeeded: true })).toBeNull();
    expect(trainingBootProblem({ trainingMode: true, appEnv: 'training', databaseSeeded: false })).toBeNull();
    expect(
      trainingBootProblem({ trainingMode: false, appEnv: 'production', databaseSeeded: false }),
    ).toBeNull();
  });
});

describe('training accounts', () => {
  it('are recognised by their reserved domain only', () => {
    expect(isTrainingEmail('owner@formation.beton.invalid')).toBe(true);
    expect(isTrainingEmail('Owner@Formation.Beton.Invalid')).toBe(true);
    expect(isTrainingEmail('owner@belgobeton.test')).toBe(false);
    expect(isTrainingEmail('x@evil.com?formation.beton.invalid')).toBe(false);
  });
});

describe('training mode refuses outside services (T1)', () => {
  it('no external language model or invoice reading next to TRAINING_MODE', () => {
    const base = { ...valid, TRAINING_MODE: 'true', APP_ENV: 'training' };
    expect(() =>
      loadEnv({
        ...base,
        ASSISTANT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
        ASSISTANT_ENABLED: 'true',
      }),
    ).toThrow(/language model/);
    expect(() => loadEnv({ ...base, AI_EXTRACTION_ENABLED: 'true' })).toThrow(/language model/);
    expect(() => loadEnv({ ...base, ASSISTANT_DET_ENABLED: 'true' })).not.toThrow();
  });
});

describe('the Funnel warning (T1)', () => {
  it('warns when a Tailscale address is served without training mode, and only then', () => {
    expect(funnelWarning({ trainingMode: false, appBaseUrl: 'https://imac.tail1234.ts.net' })).toMatch(
      /Tailscale/,
    );
    expect(funnelWarning({ trainingMode: true, appBaseUrl: 'https://imac.tail1234.ts.net' })).toBeNull();
    expect(funnelWarning({ trainingMode: false, appBaseUrl: 'https://beton.example.test' })).toBeNull();
    expect(funnelWarning({ trainingMode: false, appBaseUrl: 'https://evil-ts.net.example.test' })).toBeNull();
    expect(funnelWarning({ trainingMode: false, appBaseUrl: 'not a url' })).toBeNull();
  });
});
