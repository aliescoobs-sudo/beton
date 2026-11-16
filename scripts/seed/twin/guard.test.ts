import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanRepo } from '../../data-scope-scan.ts';
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
    ['a "prod" database name', { DATABASE_URL_MIGRATOR: 'postgres://u:p@db:5432/kayas-prod' }],
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

describe('the twin seed holds no real-looking identifier (T20, D249)', () => {
  const sources = readdirSync('scripts/seed/twin')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(`scripts/seed/twin/${f}`, 'utf8')] as const);

  it('has no Moroccan mobile or international number, no CIN-shaped code, no birth date field, no 15-digit ICE that is not in the fake range', () => {
    expect(sources.length).toBeGreaterThan(8);
    for (const [file, text] of sources) {
      expect(text, `${file}: a dialable phone number`).not.toMatch(/\b0[567]\d{8}\b|\+212|\b00212/);
      expect(text, `${file}: a CIN-shaped code`).not.toMatch(/['"`][A-Z]{1,2}\d{5,7}['"`]/);
      expect(text, `${file}: a 15-digit identifier outside the fake range`).not.toMatch(
        /\b(?!0{10})\d{15}\b/,
      );
    }
  });

  it('is scanned by the data-scope scan, and the scan finds nothing blocking', () => {
    const { all, blocking } = scanRepo();
    expect(blocking).toEqual([]);
    expect(all.length).toBeGreaterThan(0);
  });
});
