import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase, superuserUrl } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { wipeTrainingDatabase } from '../scripts/reset-training';
import { seedTraining } from '../scripts/seed-training';
import { armTrainingDay } from '../scripts/training-day';
import { businessDateOf, realClock } from '../src/modules/clock';
import { getTimingBoard } from '../src/modules/operations';
import { minuteOfDay } from '../src/modules/operations/domain/trip-times';
import { testEnv } from './db-env';

// T1: the training seed, run once on a scratch database. Fictitious data only; one account per role; credentials written once to a file
// that is not the log; RBAC and money visibility are the application's own (the seed adds no right, no bypass).
const env = testEnv(TRAINING_TEST_DATABASE);
const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
const dir = mkdtempSync(path.join(tmpdir(), 'bb-training-'));
const file = path.join(dir, 'training-accounts.local.txt');
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
// The reset drops the database under this pool's idle connection: that is expected, the pool reconnects.
migrator.on('error', () => undefined);
let first: Awaited<ReturnType<typeof seedTraining>>;
const logs: string[] = [];

beforeAll(async () => {
  await ensureRoles(training, env.DATABASE_URL_SEED);
  await recreateDatabase(training, TRAINING_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const spy = (...a: unknown[]) => void logs.push(a.join(' '));
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = spy;
  console.error = spy;
  console.warn = spy;
  try {
    first = await seedTraining({
      provenance: 'unverified-test-database',
      env: training,
      today: new Date().toISOString().slice(0, 10),
      credentialsFile: file,
    });
  } finally {
    Object.assign(console, original);
  }
}, 600_000);
afterAll(() => migrator.end());

const count = async (sql: string) => Number((await migrator.query<{ n: string }>(sql)).rows[0]!.n);

describe('the training seed (T1)', () => {
  it('refuses to run without TRAINING_MODE and next to APP_ENV=production or real data', async () => {
    const base = { today: '2026-11-04', credentialsFile: file };
    await expect(
      seedTraining({ ...base, env: { ...training, TRAINING_MODE: false as never } }),
    ).rejects.toThrow(/TRAINING_MODE/);
    await expect(
      seedTraining({ ...base, env: { ...training, APP_ENV: 'production' as never } }),
    ).rejects.toThrow(/production/);
    await expect(seedTraining({ ...base, env: { ...training, REAL_DATA: true } })).rejects.toThrow(
      /REAL_DATA/,
    );
  });

  it('seeds two plants, trucks of the asked sizes, three pumps, parties that are obviously fake', async () => {
    expect(first.applied).toBe(true);
    const plants = await migrator.query<{ name: string }>(
      `select name from plant where status = 'active' order by name`,
    );
    expect(plants.rows.map((p) => p.name)).toEqual(['Centrale de Chefchaouen', 'Centrale de Tétouan']);
    const sizes = await migrator.query<{ plant: string | null; capacity_l: number; n: string }>(
      `select (select code from plant p where p.id = t.plant_id) as plant, capacity_l, count(*)::text as n
         from truck t where kind = 'mixer' group by 1, 2 order by 1, 2`,
    );
    expect(sizes.rows.map((r) => `${r.plant}:${r.capacity_l}:${r.n}`)).toEqual([
      'CHEFCHN:10000:1',
      'CHEFCHN:11000:4',
      'TETOUAN:16000:4',
    ]);
    expect(await count(`select count(*) n from truck where kind = 'pump'`)).toBe(3);
    expect(await count(`select count(*) n from supplier where name = 'Ciment Démo'`)).toBe(1);
    // no party carries a real-looking identifier: every ICE of the training parties is zeros then a small number
    const ices = await migrator.query<{ ice: string }>(
      `select ice from client where ice is not null union all select ice from supplier where ice is not null`,
    );
    for (const r of ices.rows) expect(r.ice).toMatch(/^0{10,}\d+$/);
  });

  it('has recipes and reference prices per plant, and activity in both plants', async () => {
    expect(await count(`select count(*) n from recette where plant_id is not null`)).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      await count(`select count(*) n from selling_price where plant_id is not null`),
    ).toBeGreaterThanOrEqual(4);
    for (const code of ['TETOUAN', 'CHEFCHN']) {
      expect(
        await count(
          `select count(*) n from sales_order o join plant p on p.id = o.plant_id where p.code = '${code}'`,
        ),
        code,
      ).toBeGreaterThan(0);
    }
    expect(await count(`select count(*) n from payment_instrument`)).toBeGreaterThan(0);
    expect(await count(`select count(*) n from delivery`)).toBeGreaterThan(0);
    expect(await count(`select count(*) n from plant_transfer`)).toBe(2);
    expect(await count(`select count(*) n from receipt_arrival_line`)).toBeGreaterThan(0);
    expect(await count(`select count(*) n from pump_job where plant_id is not null`)).toBeGreaterThan(0);
  });

  it('creates one account per role and the credentials file, readable by its owner only', async () => {
    const roles = await migrator.query<{ role: string; n: string }>(
      `select role, count(*)::text as n from "user" group by role order by role`,
    );
    const by = Object.fromEntries(roles.rows.map((r) => [r.role, Number(r.n)]));
    expect(by).toMatchObject({
      owner: 1,
      app_admin: 1,
      office_sales: 1,
      office_purchases: 1,
      plant_manager: 2,
      accountant: 1,
      pump_operator: 1,
    });
    expect(by.driver).toBeGreaterThanOrEqual(3);
    const mgr = await migrator.query<{ code: string }>(
      `select p.code from "user" u join plant p on p.id = u."plantId" where u.role = 'plant_manager' order by 1`,
    );
    expect(mgr.rows.map((r) => r.code)).toEqual(['CHEFCHN', 'TETOUAN']);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text.match(/mot de passe :/g)?.length).toBe(7);
    expect(text.match(/PIN :/g)?.length).toBe(4);
  });

  it('never prints a password or a PIN, and the credentials are not stored in clear in the database', async () => {
    const secrets = [...readFileSync(file, 'utf8').matchAll(/(?:mot de passe|PIN) : (\S+)/g)].map(
      (m) => m[1]!,
    );
    expect(secrets.length).toBe(11);
    const everything = logs.join('\n');
    for (const s of secrets) expect(everything).not.toContain(s);
    const hashes = await migrator.query<{ v: string }>(
      `select password as v from account where password is not null union all select pin_hash from driver_pin`,
    );
    for (const s of secrets) for (const h of hashes.rows) expect(h.v).not.toContain(s);
  });

  it('writes the marker last, and a second run leaves everything alone', async () => {
    expect(await count(`select count(*) n from training_marker`)).toBe(1);
    const again = await seedTraining({
      provenance: 'unverified-test-database',
      env: training,
      today: new Date().toISOString().slice(0, 10),
      credentialsFile: path.join(dir, 'training-accounts.second.local.txt'),
    });
    expect(again.applied).toBe(false);
    expect(existsSync(path.join(dir, 'training-accounts.second.local.txt'))).toBe(false);
  });
});

describe('reset:training (T1)', () => {
  it('R14-13: the helper itself refuses without the mode flags, whatever the CLI did', async () => {
    const base = { ...testEnv(TRAINING_TEST_DATABASE) };
    await expect(wipeTrainingDatabase({ ...base, TRAINING_MODE: false })).rejects.toThrow(
      /TRAINING_MODE=true/,
    );
    await expect(
      wipeTrainingDatabase({ ...base, TRAINING_MODE: true, APP_ENV: 'production' }),
    ).rejects.toThrow(/APP_ENV not production/);
    await expect(wipeTrainingDatabase({ ...base, TRAINING_MODE: true, REAL_DATA: true })).rejects.toThrow(
      /REAL_DATA off/,
    );
    expect(await count(`select count(*) n from training_marker`)).toBe(1); // nothing was dropped
  });
  it('R14-13: without a runner signal, a marked database on a cluster with no birth row for it is not reset', async () => {
    const sup = new pg.Client({ connectionString: superuserUrl(training, 'postgres') });
    await sup.connect();
    try {
      await sup.query('drop table if exists public.volume_birth'); // a cluster that never had a birth row
    } finally {
      await sup.end();
    }
    vi.stubEnv('VITEST', '');
    try {
      await expect(wipeTrainingDatabase(training)).rejects.toThrow(/no birth row for it/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await count(`select count(*) n from training_marker`)).toBe(1);
  });
  it('refuses to wipe a database that does not carry the training marker', async () => {
    // belgobeton_test is a plain test database: no marker, so it is never dropped
    await expect(
      wipeTrainingDatabase({ ...testEnv(), TRAINING_MODE: true, APP_ENV: 'training' }),
    ).rejects.toThrow(/does not carry the training marker/);
    expect(await count(`select count(*) n from training_marker`)).toBe(1); // the training database is untouched by that attempt
  });
  it('wipes the training database and seeds it again with new credentials', async () => {
    const before = readFileSync(file, 'utf8');
    await wipeTrainingDatabase(training);
    await runMigrations(env.DATABASE_URL_MIGRATOR);
    expect(await count(`select count(*) n from "user"`)).toBe(0);
    const again = await seedTraining({
      provenance: 'unverified-test-database',
      env: training,
      today: new Date().toISOString().slice(0, 10),
      credentialsFile: file,
    });
    expect(again.applied).toBe(true);
    const after = readFileSync(file, 'utf8');
    expect(after).not.toBe(before);
    const oldSecrets = [...before.matchAll(/(?:mot de passe|PIN) : (\S+)/g)].map((m) => m[1]!);
    for (const s of oldSecrets) expect(after).not.toContain(s);
  }, 600_000);
});

describe('the training day is dated from the business day (T5)', () => {
  const addDays = (iso: string, n: number) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const notStarted = async (date: string) =>
    (
      await migrator.query<{ code: string; n: string }>(
        `select d.code, count(p.id)::text as n from driver d
           join trip_plan p on p.driver_id = d.id and p.trip_date = $1
          where d.user_id is not null and d.kind = 'driver'
            and not exists (select 1 from trip_plan_cancellation x where x.trip_id = p.id)
            and not exists (select 1 from trip_event e where e.trip_id = p.id)
          group by d.code order by d.code`,
        [date],
      )
    ).rows;
  it('after the seed each of the three phone drivers has 2 or 3 rotations still to do today', async () => {
    const rows = await notStarted(today);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(Number(r.n)).toBeGreaterThanOrEqual(2);
      expect(Number(r.n)).toBeLessThanOrEqual(3);
    }
  });
  it('the history is dated before today and the other roles find work: quotes, an unplanned order, an order to cancel, low stock', async () => {
    expect(
      await count(
        `select count(*)::text n from trip_plan where trip_date < '${today}' and trip_date >= '${addDays(today, -40)}'`,
      ),
    ).toBeGreaterThan(10);
    expect(await count(`select count(*)::text n from quote`)).toBeGreaterThanOrEqual(2);
    expect(
      await count(
        `select count(*)::text n from sales_order o where o.delivery_date = '${today}' and o.reverses_id is null
            and not exists (select 1 from sales_order r where r.reverses_id = o.id)
            and not exists (select 1 from trip_plan p where p.order_id = o.id)`,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await count(`select count(*)::text n from sales_order where delivery_date = '${addDays(today, 1)}'`),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        `select count(*)::text n from audit_event where table_name = 'stock_threshold' and action = 'insert'`,
      ),
    ).toBeGreaterThanOrEqual(1);
  });
  it('re-arming the same day does not double the rotations; arming the next morning gives that day its own', async () => {
    const before = await notStarted(today);
    const first = await armTrainingDay({ ...training, DATABASE_URL_SEED: env.DATABASE_URL_SEED }, today);
    expect(first.rotationsPlanned).toBeGreaterThanOrEqual(6);
    const again = await notStarted(today);
    expect(again.map((r) => r.code)).toEqual(before.map((r) => r.code));
    for (const r of again) expect(Number(r.n)).toBeLessThanOrEqual(3);
    const tomorrow = addDays(today, 1);
    expect(await notStarted(tomorrow)).toHaveLength(0);
    await armTrainingDay({ ...training, DATABASE_URL_SEED: env.DATABASE_URL_SEED }, tomorrow);
    const next = await notStarted(tomorrow);
    expect(next).toHaveLength(3);
    for (const r of next) expect(Number(r.n)).toBeGreaterThanOrEqual(2);
  }, 120_000);
  it('refuses a database without the training marker', async () => {
    const other = {
      ...training,
      DATABASE_URL_MIGRATOR: env.DATABASE_URL_MIGRATOR.replace(/\/[^/]+$/, '/belgobeton_test'),
      DATABASE_URL_APP: env.DATABASE_URL_APP.replace(/\/[^/]+$/, '/belgobeton_test'),
    };
    await expect(armTrainingDay(other, today)).rejects.toThrow(/training marker/);
  });
});

describe('the training day carries timing: history, estimates and a rotation running late (T5 phase 2)', () => {
  const today = businessDateOf(realClock.now());
  const ownerSession = async () => {
    const u = (
      await migrator.query<{ id: string; name: string; email: string }>(
        `select id, name, email from "user" where email like 'proprietaire@%'`,
      )
    ).rows[0]!;
    return {
      ...u,
      role: 'owner',
      locale: 'fr',
      twoFactorEnabled: false,
      reenrolRequired: false,
      stepUpVerified: true,
    } as never;
  };
  const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
  afterAll(() => app.end());

  it('at least 30 completed rotations of the history carry their stage delays', async () => {
    expect(
      await count(`select count(distinct trip_id)::text n from trip_delay where step = 'back'`),
    ).toBeGreaterThanOrEqual(30);
    expect(
      await count(`select count(*)::text n from trip_delay where stage_delay_min is not null`),
    ).toBeGreaterThan(100);
  });
  it('the estimates of a route come from the history of its completed rotations, and an override is audited', async () => {
    const board = await getTimingBoard(app, await ownerSession(), today, realClock.now().getTime());
    const sources = Object.values(board.estimates).flatMap((e) => Object.values(e).map((v) => v.source));
    expect(sources).toContain('history');
    expect(
      await count(
        `select count(*)::text n from audit_event where table_name = 'trip_estimate_override' and action = 'insert'`,
      ),
    ).toBeGreaterThanOrEqual(1);
  });
  it('one rotation is on the road and late: its truck is critical and names the next order', async () => {
    if (minuteOfDay(realClock.now().toISOString()) < 85) return; // the rotation would have to start yesterday
    const board = await getTimingBoard(app, await ownerSession(), today, realClock.now().getTime());
    const critical = board.trucks.filter((t) => t.alert.level === 'critical');
    expect(critical.length).toBeGreaterThanOrEqual(1);
    const t = critical.find((x) => (x.trips[0]!.cumulativeDelayMin ?? 0) >= 25)!;
    expect(t).toBeDefined();
    expect(t.status).toBe('en_route');
    expect(t.alert.slipMin).toBeGreaterThan(0);
    expect(t.alert.nextOrderCode).toMatch(/^CMD-/);
  });
});
