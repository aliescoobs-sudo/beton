import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceClock,
  type AdvanceDeps,
  casablancaInstant,
  JOB_CATALOGUE,
  type JobHandler,
  SimulationDisabledError,
  stubJobRegistry,
  syncSimClock,
} from '../src/modules/clock';
import type { BusinessDate } from '../src/modules/clock/domain/business-date';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';
import { resetSimClock } from './helpers/reset-sim-clock';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(async () => {
  await resetSimClock();
  await Promise.all([app.end(), system.end(), migrator.end()]);
});
beforeEach(resetSimClock);

const DAY = 86_400_000;
/** A random far-future start so reruns never meet job-run rows of a previous run. */
const freshStart = () => {
  const date = new Date(Date.UTC(2100, 0, 1) + Math.floor(Math.random() * 20_000) * DAY);
  return casablancaInstant(date.toISOString().slice(0, 10) as BusinessDate, '07:00');
};

async function deps(overrides: Partial<AdvanceDeps> = {}): Promise<AdvanceDeps> {
  return {
    simulationEnabled: true,
    appPool: app,
    systemPool: system,
    registry: stubJobRegistry(),
    timeOf: async (_key, def) => def,
    ...overrides,
  };
}

async function startAt(instant: Date) {
  await syncSimClock(system, true, SYSTEM_ACTOR_ID, instant);
  return { userId: (await realActor(env.DATABASE_URL_MIGRATOR, 'owner')).id, role: 'owner' as const };
}

const relative = (start: Date, d: Date) => (d.getTime() - start.getTime()) / 60_000;
const relDay = (start: Date, d: string) =>
  (Date.parse(d) - Date.parse(start.toISOString().slice(0, 10))) / DAY;

async function simClockAudit(since: number) {
  const { rows } = await migrator.query<{
    id: string;
    actor_kind: string;
    actor_user_id: string;
    before: { sim_now: string };
    after: { sim_now: string };
  }>(
    `select id, actor_kind, actor_user_id, before, after from audit_event
      where table_name = 'sim_clock' and id > $1 order by id`,
    [since],
  );
  return rows;
}
const lastAuditId = async () =>
  Number((await migrator.query(`select coalesce(max(id), 0) as id from audit_event`)).rows[0].id);

describe('advance (T24)', () => {
  it('runs each daily job once per crossed day, in order, and nothing on a re-advance (AC-CLK-03)', async () => {
    const d1 = freshStart();
    const owner = await startAt(d1);
    const result = await advanceClock(await deps(), owner, { byDays: 3 });

    const perDay = JOB_CATALOGUE.length;
    expect(result.failed).toBe(false);
    expect(result.ran.every((r) => r.outcome === 'ran')).toBe(true);
    // D1 07:05 + 20:00, D2 and D3 in full, D4 06:30 + 07:00
    expect(result.ran).toHaveLength(2 + 2 * perDay + 2);
    const keys = result.ran.map((r) => r.jobKey);
    expect(keys.slice(0, 2)).toEqual(['due-reminders', 'day-close']);
    expect(keys.slice(2, 6)).toEqual(JOB_CATALOGUE.map((j) => j.key));

    // Rewind the clock (test-only reset) and advance over the same instants: every run is skipped.
    await resetSimClock();
    await startAt(d1);
    const again = await advanceClock(await deps(), owner, { byDays: 3 });
    expect(again.ran).toHaveLength(result.ran.length);
    expect(again.ran.every((r) => r.outcome === 'skipped')).toBe(true);
  });

  it('advancing 3 days ≡ 3 × 1 day (AC-CLK-04)', async () => {
    async function trace(steps: number[]) {
      await resetSimClock();
      const start = freshStart();
      const owner = await startAt(start);
      const since = await lastAuditId();
      const ran: string[] = [];
      for (const byDays of steps) {
        const r = await advanceClock(await deps(), owner, { byDays });
        ran.push(...r.ran.map((x) => `${relDay(start, x.businessDate)} ${x.jobKey} ${x.outcome}`));
      }
      const audit = (await simClockAudit(since)).map(
        (e) =>
          `${e.actor_kind} ${relative(start, new Date(e.before.sim_now))}→${relative(start, new Date(e.after.sim_now))}`,
      );
      return { ran, audit };
    }
    const threeDays = await trace([3]);
    const oneByOne = await trace([1, 1, 1]);
    expect(oneByOne.ran).toEqual(threeDays.ran);
    expect(oneByOne.audit).toEqual(threeDays.audit);
  });

  it('audits the move with the owner as actor and from/to (AC-CLK-06, audit part)', async () => {
    const d1 = freshStart();
    const owner = await startAt(d1);
    const since = await lastAuditId();
    await advanceClock(await deps(), owner, { to: new Date(d1.getTime() + 3 * 60_000) });
    const events = await simClockAudit(since);
    expect(events).toHaveLength(1);
    const [event] = events as [(typeof events)[number]];
    expect(event.actor_user_id).toBe(owner.userId);
    expect(new Date(event.before.sim_now).getTime()).toBe(d1.getTime());
    expect(new Date(event.after.sim_now).getTime()).toBe(d1.getTime() + 3 * 60_000);
  });

  it('refuses when simulation is disabled and when the target is not later', async () => {
    const d1 = freshStart();
    const owner = await startAt(d1);
    await expect(
      advanceClock(await deps({ simulationEnabled: false }), owner, { byDays: 1 }),
    ).rejects.toBeInstanceOf(SimulationDisabledError);
    await expect(advanceClock(await deps(), owner, { to: new Date(d1.getTime() - DAY) })).rejects.toThrow(
      /only move forward/,
    );
    await expect(advanceClock(await deps(), owner, { byDays: 400 })).rejects.toThrow(/more than/);
  });

  it('runs scripted events between the jobs, in order', async () => {
    const d1 = freshStart();
    const owner = await startAt(d1);
    const order: string[] = [];
    const registry = new Map<string, JobHandler>(
      JOB_CATALOGUE.map((j) => [j.key, async () => void order.push(j.key)]),
    );
    const eventAt = new Date(casablancaInstant(d1.toISOString().slice(0, 10) as BusinessDate, '12:00'));
    await advanceClock(
      await deps({
        registry,
        scriptedEvents: async () => [{ at: eventAt, run: async () => void order.push('event') }],
      }),
      owner,
      { byDays: 1 },
    );
    expect(order.slice(0, 3)).toEqual(['due-reminders', 'event', 'day-close']);
  });

  it('stops at a failed job and leaves sim_now at that instant', async () => {
    const d1 = freshStart();
    const owner = await startAt(d1);
    const registry = new Map<string, JobHandler>(
      JOB_CATALOGUE.map((j) => [
        j.key,
        async () => {
          if (j.key === 'day-close') throw new Error('boom');
        },
      ]),
    );
    const result = await advanceClock(await deps({ registry }), owner, { byDays: 2 });
    expect(result.failed).toBe(true);
    expect(result.ran.map((r) => r.outcome)).toEqual(['ran', 'failed']);
    expect(result.to.getTime()).toBe(
      casablancaInstant(d1.toISOString().slice(0, 10) as BusinessDate, '20:00').getTime(),
    );
  });
});
