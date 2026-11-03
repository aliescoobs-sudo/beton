import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../scripts/db-migrate';
import { resolveStartMode, type Checklist } from '../src/modules/platform-security/service/checklist';
import { testEnv } from './db-env';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(() => Promise.all([app.end(), system.end()]));

describe('boot probes (C2, CODEX-REVIEW-R9 items 5 and 13)', () => {
  it('readiness counts the applied migrations against the journal of this build', async () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'));
    const { rows } = await app.query('select public.applied_migrations() as n');
    expect(rows[0].n).toBe(journal.entries.length);
  });
  it('the record count is for the system login only', async () => {
    await expect(app.query('select public.first_boot_record_count()')).rejects.toMatchObject({
      code: '42501',
    });
    const { rows } = await system.query('select public.first_boot_record_count() as n');
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(0);
  });
});

const list = (complete: boolean): Checklist => ({ items: [], complete });
describe('the protected first start never becomes a standing way around the guard', () => {
  const start = (o: { realData: boolean; firstBoot: boolean; complete: boolean; records?: number }) =>
    resolveStartMode({
      realData: o.realData,
      firstBoot: o.firstBoot,
      getList: async () => list(o.complete),
      countRecords: async () => o.records ?? 0,
    });
  it('an incomplete checklist stops a normal start but allows the restricted one on an empty server', async () => {
    await expect(start({ realData: true, firstBoot: false, complete: false })).rejects.toThrow(
      /REAL_DATA=true refused/,
    );
    expect(await start({ realData: true, firstBoot: true, complete: false })).toBe('first_boot');
  });
  it('refuses the restricted start next to real records, once complete, or without REAL_DATA', async () => {
    await expect(start({ realData: true, firstBoot: true, complete: false, records: 1 })).rejects.toThrow(
      /records/,
    );
    await expect(start({ realData: true, firstBoot: true, complete: true })).rejects.toThrow(
      /remove FIRST_BOOT/,
    );
    await expect(start({ realData: false, firstBoot: true, complete: false })).rejects.toThrow(
      /only for REAL_DATA/,
    );
  });
  it('a complete checklist starts normally; without REAL_DATA nothing is checked', async () => {
    expect(await start({ realData: true, firstBoot: false, complete: true })).toBe('normal');
    expect(await start({ realData: false, firstBoot: false, complete: false })).toBe('normal');
  });
});
