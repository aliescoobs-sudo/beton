import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setMyLocale } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// R8 (REQUIREMENTS-V1 §13): Darija is a language an account can have; an account changes only its own.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await Promise.all([app.end(), migrator.end()]);
});
const marker = `dj${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const u = {} as Record<string, SessionUser>;
const localeOf = async (id: string) =>
  (await migrator.query<{ locale: string }>(`select locale from "user" where id = $1`, [id])).rows[0]?.locale;

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  for (const r of ['office_sales', 'plant_manager'] as const) u[r] = v.session(r);
});

describe('per-user language', () => {
  it('an account switches to Darija and back, and only its own row changes', async () => {
    const before = await localeOf(u.plant_manager!.id);
    expect((await setMyLocale(app, u.office_sales!, 'ary')).ok).toBe(true);
    expect(await localeOf(u.office_sales!.id)).toBe('ary');
    expect(await localeOf(u.plant_manager!.id)).toBe(before);
    expect((await setMyLocale(app, u.office_sales!, 'ar')).ok).toBe(true);
    expect(await localeOf(u.office_sales!.id)).toBe('ar');
  });
  it('an unknown language is refused by the code and by the database', async () => {
    expect((await setMyLocale(app, u.office_sales!, 'en')).ok).toBe(false);
    await expect(migrator.query(`select 1`)).resolves.toBeDefined();
    await expect(
      migrator.query(`update "user" set locale = 'en' where id = $1`, [u.office_sales!.id]),
    ).rejects.toThrow();
  });
  it('the database accepts Darija on the account', async () => {
    await expect(
      migrator.query(`update "user" set locale = 'ary' where id = $1`, [u.office_sales!.id]),
    ).resolves.toBeDefined();
  });
});
