import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { recordClockAdvance } from '../src/modules/platform-security/service/clock-audit';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

describe('clock_advance audit event (AC-CLK-06)', () => {
  it('records one event with the owner as actor and from/to', async () => {
    const owner = await realActor(env.DATABASE_URL_MIGRATOR, 'owner');
    const from = new Date('2126-01-05T07:00:00Z');
    const to = new Date('2126-01-08T07:00:00Z');
    const { rows: before } = await migrator.query(`select coalesce(max(id), 0) as id from audit_event`);
    await recordClockAdvance(app, owner.id, { from, to, requested: { byDays: 3 }, outcome: 'advanced' });
    const { rows } = await migrator.query(
      `select action, table_name, actor_user_id, actor_kind, before, after from audit_event
        where id > $1 and action = 'clock_advance'`,
      [before[0].id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      table_name: 'sim_clock',
      actor_user_id: owner.id,
      actor_kind: 'user',
      before: { sim_now: from.toISOString() },
      after: { sim_now: to.toISOString(), requested: { byDays: 3 }, outcome: 'advanced' },
    });
  });

  it('records a failed job and a refusal', async () => {
    const owner = await realActor(env.DATABASE_URL_MIGRATOR, 'owner');
    await recordClockAdvance(app, owner.id, {
      from: new Date('2126-01-05T07:00:00Z'),
      to: new Date('2126-01-05T20:00:00Z'),
      requested: { byDays: 2 },
      outcome: 'job_failed',
      failedJob: 'day-close',
    });
    await recordClockAdvance(app, owner.id, {
      requested: { byDays: 400 },
      outcome: 'rejected',
      detail: 'Cannot advance by more than 366 days at once',
    });
    const { rows } = await migrator.query(
      `select after, reason from audit_event where action = 'clock_advance' order by id desc limit 2`,
    );
    expect(rows[0].after.outcome).toBe('rejected');
    expect(rows[1].after).toMatchObject({ outcome: 'job_failed', failed_job: 'day-close' });
  });
});
