import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestClock, installJobQueue, startJobScheduler } from '../src/modules/clock';
import { testEnv } from './db-env';

// A dropped database connection ("connection timeout", terminated backend, restart) must not stop the worker for good.
const env = testEnv();
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
afterAll(() => system.end());

async function jobState(boss: PgBoss, id: string): Promise<string | undefined> {
  return (await boss.getJobById('day-close', id))?.state;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined as T);
    if (value !== undefined && done(value)) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('pg-boss worker', () => {
  it('keeps working after every one of its database connections is killed', async () => {
    await installJobQueue(env.DATABASE_URL_MIGRATOR);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = await startJobScheduler(
      env.DATABASE_URL_SYSTEM,
      {
        pool: system,
        clock: createTestClock(new Date()),
        registry: new Map([['day-close', async () => undefined]]),
      },
      async (_k, defaultTime) => defaultTime,
    );
    let client: PgBoss | undefined;
    try {
      const killed = await system.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and usename = current_user and pid <> pg_backend_pid()
            and application_name like 'pgboss%'`,
      );
      expect(killed.rowCount).toBeGreaterThan(0);
      client = new PgBoss({
        connectionString: env.DATABASE_URL_SYSTEM,
        schema: 'pgboss',
        migrate: false,
        createSchema: false,
        supervise: false,
        schedule: false,
      });
      client.on('error', () => undefined);
      await client.start();
      const id = (await client.send('day-close', null))!;
      await until(
        () => jobState(client!, id),
        (s) => s === 'completed',
      );
    } finally {
      await client?.stop({ graceful: false });
      await scheduler.stop();
    }
  }, 60_000);
});
