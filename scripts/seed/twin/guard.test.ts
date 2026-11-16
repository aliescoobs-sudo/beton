import { describe, expect, it } from 'vitest';
import { FAKE_ICE, FAKE_PHONE, fakeIce, fakePhone } from './data.ts';
import { TWIN_ANCHOR, databaseName, productionLooking, twinEnvProblem } from './guard.ts';

const ok = {
  TWIN_SEED_FICTITIOUS: 'true',
  TRAINING_MODE: true,
  APP_ENV: 'training',
  REAL_DATA: false,
  APP_BASE_URL: 'https://kayas.aliobsil.com',
  DATABASE_URL_MIGRATOR: 'postgres://u:p@db:5432/kayas',
};

describe('the twin seed guard (T20)', () => {
  it('lets a flagged training instance through', () => {
    expect(twinEnvProblem(ok)).toBeNull();
    expect(productionLooking(ok)).toBeNull();
  });

  it('refuses without the explicit fictitious flag, whatever else is right', () => {
    expect(twinEnvProblem({ ...ok, TWIN_SEED_FICTITIOUS: undefined })).toMatch(/TWIN_SEED_FICTITIOUS/);
    expect(twinEnvProblem({ ...ok, TWIN_SEED_FICTITIOUS: 'yes' })).toMatch(/TWIN_SEED_FICTITIOUS/);
    expect(twinEnvProblem({ ...ok, TWIN_SEED_FICTITIOUS: '1' })).toMatch(/TWIN_SEED_FICTITIOUS/);
  });

  it.each([
    ['APP_ENV production', { APP_ENV: 'production' }],
    ['real data', { REAL_DATA: true }],
    ['not a training instance', { TRAINING_MODE: false }],
    ['a production database name', { DATABASE_URL_MIGRATOR: 'postgres://u:p@db:5432/kayas_production' }],
    ['a "prod" database name', { DATABASE_URL_MIGRATOR: 'postgres://u:p@db:5432/belgobeton-prod' }],
    ['a live database name', { DATABASE_URL_MIGRATOR: 'postgres://u:p@db:5432/live' }],
    ['a production host', { APP_BASE_URL: 'https://prod.example.test' }],
    [
      'a production database host',
      { DATABASE_URL_MIGRATOR: 'postgres://u:p@db.production.internal:5432/kayas' },
    ],
  ])('refuses %s, even with the flag', (_label, change) => {
    const problem = twinEnvProblem({ ...ok, ...change });
    expect(problem).toMatch(/^twin seed refused: /);
  });

  it('does not mistake an innocent name for production', () => {
    for (const url of [
      'postgres://u:p@db/belgobeton_training_test',
      'postgres://u:p@db/kayas_product_demo',
      'postgres://u:p@db/preprod_twin',
    ])
      expect(twinEnvProblem({ ...ok, DATABASE_URL_MIGRATOR: url })).toBeNull();
  });

  it('reads the database name', () => {
    expect(databaseName('postgres://u:p@h:5432/kayas')).toBe('kayas');
    expect(databaseName(undefined)).toBeNull();
    expect(databaseName('not a url')).toBeNull();
  });

  it('uses a fixed anchor and a reserved fake range for numbers and ICE', () => {
    expect(TWIN_ANCHOR).toBe('2026-11-15');
    for (const n of [1, 30, 9100]) {
      expect(fakePhone(n)).toMatch(FAKE_PHONE);
      expect(fakeIce(n)).toMatch(FAKE_ICE);
      expect(fakeIce(n)).toHaveLength(15);
    }
  });
});
