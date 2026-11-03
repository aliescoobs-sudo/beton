import { describe, it, expect } from 'vitest';
import { assertFinanceTarget, financeBuildEnvironment } from './finance-run';
const env = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...Object.fromEntries(
    ['APP', 'AUTH', 'MIGRATOR', 'SYSTEM', 'BACKUP', 'SEED'].map((name) => [
      'DATABASE_URL_' + name,
      'postgres://localhost:5542/belgobeton_finance',
    ]),
  ),
  REAL_DATA: 'false',
});
describe('finance runner refuses the original environment before connecting', () => {
  it('keeps operations credentials out of the Next build process', () => {
    const build = financeBuildEnvironment({
      ...env(),
      POSTGRES_SUPERUSER_PASSWORD: 'synthetic',
      BACKUP_AGE_IDENTITY_FILE: 'fake-file',
    });
    for (const key of [
      'POSTGRES_SUPERUSER_PASSWORD',
      'DATABASE_URL_BACKUP',
      'DATABASE_URL_SEED',
      'BACKUP_AGE_IDENTITY_FILE',
    ])
      expect(build[key]).toBeUndefined();
    expect(build.SIMULATION_ENABLED).toBe('false');
    expect(build.DATABASE_URL_APP).toBe(env().DATABASE_URL_APP);
  });
  it('accepts only the isolated loopback database', () => {
    expect(() => assertFinanceTarget(env())).not.toThrow();
  });
  it.each([
    'postgres://localhost:5432/belgobeton',
    'postgres://remote.test:5542/belgobeton_finance',
    'postgres://localhost:5542/belgobeton',
    'https://localhost:5542/belgobeton_finance',
  ])('rejects %s', (url) => {
    expect(() => assertFinanceTarget({ ...env(), DATABASE_URL_APP: url })).toThrow('refusing');
  });
  it('refuses real data and missing URLs without including their values in errors', () => {
    expect(() => assertFinanceTarget({ ...env(), REAL_DATA: 'true' })).toThrow('synthetic');
    expect(() => assertFinanceTarget({ ...env(), DATABASE_URL_SEED: undefined })).toThrow(
      'missing isolated URL',
    );
  });
});
