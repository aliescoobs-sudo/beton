import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClock,
  installJobQueue,
  type JobRegistry,
  runJob,
  scheduledHandler,
  startJobScheduler,
  SYSTEM_ACTOR_ID,
} from '../src/modules/clock';
import { withRlsContext } from '../src/lib/db/rls-context';
import { type BusinessDate } from '../src/modules/clock/domain/business-date';
import { testEnv } from './db-env';

const env = testEnv();
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 5 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const clock = createTestClock(new Date('2026-03-02T06:30:00Z'));
const day = (d: string) => d as BusinessDate;
const readRuns = (key: string) =>
  withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 't23-read' }, (tx) =>
    tx.query(`select status, error from scheduled_job_run where job_key = $1`, [key]),
  );
const job = (suffix: string) => `t23-${suffix}-${Date.now().toString(36)}`;

beforeAll(async () => {
  await installJobQueue(env.DATABASE_URL_MIGRATOR);
});
afterAll(() => Promise.all([system.end(), migrator.end()]));

function registryOf(key: string, handler: () => Promise<void> = async () => undefined): JobRegistry {
  return new Map([[key, handler]]);
}

describe('job runner (T23)', () => {
  it('runs the handler once for the same job and business date (AC-CLK-03, idempotency)', async () => {
    const key = job('once');
    let calls = 0;
    const deps = { pool: system, clock, registry: registryOf(key, async () => void calls++) };

    expect(await runJob(deps, key, day('2026-03-02'))).toBe('ran');
    expect(await runJob(deps, key, day('2026-03-02'))).toBe('skipped');
    expect(calls).toBe(1);
    expect(await runJob(deps, key, day('2026-03-03'))).toBe('ran');
    expect(calls).toBe(2);
  });

  it('runs concurrent duplicates once', async () => {
    const key = job('race');
    let calls = 0;
    const deps = {
      pool: system,
      clock,
      registry: registryOf(key, async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
      }),
    };
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => runJob(deps, key, day('2026-03-02'))));
    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('audits job writes with actor_kind = system', async () => {
    const key = job('audit');
    await runJob({ pool: system, clock, registry: registryOf(key) }, key, day('2026-03-02'));
    const { rows } = await migrator.query<{ actor_kind: string; actor_user_id: string }>(
      `select actor_kind, actor_user_id from audit_event
        where table_name = 'scheduled_job_run' and after ->> 'job_key' = $1 order by at, id`,
      [key],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actor_kind === 'system' && r.actor_user_id === SYSTEM_ACTOR_ID)).toBe(true);
  });

  it('rolls back a failing handler, records the failure and allows a retry', async () => {
    const key = job('fail');
    let fail = true;
    const deps = {
      pool: system,
      clock,
      registry: registryOf(key, async () => {
        if (fail) throw new Error('boom');
      }),
    };
    expect(await runJob(deps, key, day('2026-03-02'))).toBe('failed');
    const failed = await readRuns(key);
    expect(failed.rows).toEqual([{ status: 'failed', error: 'boom' }]);

    fail = false;
    expect(await runJob(deps, key, day('2026-03-02'))).toBe('ran');
    const done = await readRuns(key);
    expect(done.rows).toEqual([{ status: 'succeeded', error: null }]);
  });

  it('books a scheduled job on the business date of its firing, not of the run (late worker)', async () => {
    const key = job('late');
    const seen: string[] = [];
    const deps = {
      pool: system,
      // The worker picks the job up after midnight, Casablanca time.
      clock: createTestClock(new Date('2026-03-03T00:30:00Z')),
      registry: registryOf(key, async () => void seen.push('ran')),
    };
    await scheduledHandler(deps, key)([{ createdOn: new Date('2026-03-02T20:00:05Z') }]);
    const { rows } = await withRlsContext(
      system,
      { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 't23-late' },
      (tx) =>
        tx.query<{ business_date: string }>(
          `select business_date::text as business_date from scheduled_job_run where job_key = $1`,
          [key],
        ),
    );
    expect(rows).toEqual([{ business_date: '2026-03-02' }]);
    expect(seen).toEqual(['ran']);
  });

  it('refuses an unknown job', async () => {
    await expect(
      runJob({ pool: system, clock, registry: new Map() }, 'nope', day('2026-03-02')),
    ).rejects.toThrow('Unknown job');
  });

  it('starts and stops the pg-boss scheduler against the test database', async () => {
    const scheduler = await startJobScheduler(
      env.DATABASE_URL_SYSTEM,
      { pool: system, clock, registry: new Map() },
      async (_k, defaultTime) => defaultTime,
    );
    const { rows } = await migrator.query<{ name: string; cron: string; timezone: string }>(
      `select name, cron, timezone from pgboss.schedule order by name`,
    );
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['morning-recompute', 'daily-brief', 'due-reminders', 'day-close']),
    );
    expect(rows.find((r) => r.name === 'day-close')).toMatchObject({
      cron: '0 20 * * *',
      timezone: 'Africa/Casablanca',
    });
    await scheduler.stop();
  });
});
