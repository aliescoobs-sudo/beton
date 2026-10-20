import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { BUSINESS_TIME_ZONE } from '../domain/business-date';
import { dailyCron, JOB_CATALOGUE } from '../domain/job-catalogue';
import { realClock } from './clock';
import { type JobRunnerDeps, runJob } from './job-runner';

const QUEUE_SCHEMA = 'pgboss';

/**
 * One-off install of pg-boss's own schema, run with the migrator URL (the runtime roles have no DDL rights) and then
 * handed to the system role. Idempotent.
 */
export async function installJobQueue(migratorUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: QUEUE_SCHEMA,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => undefined);
  try {
    await boss.start();
    // Queues are partitions (DDL), so they are created here, not by the runtime role.
    for (const job of JOB_CATALOGUE) await boss.createQueue(job.key);
  } finally {
    await boss.stop({ graceful: false });
  }
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query(`
      GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO belgobeton_system;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} TO belgobeton_system;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO belgobeton_system;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${QUEUE_SCHEMA} TO belgobeton_system;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${QUEUE_SCHEMA}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO belgobeton_system;`);
  } finally {
    await client.end();
  }
}

export interface JobScheduler {
  stop(): Promise<void>;
}

/**
 * Real mode only: pg-boss cron fires each catalogue job at its Africa/Casablanca time. The handler goes through
 * `runJob`, so a duplicate fire (restart, two instances) is a no-op. In simulated mode `advance` drives jobs.
 */
export async function startJobScheduler(
  systemUrl: string,
  deps: JobRunnerDeps,
  timeOf: (parameterKey: string, defaultTime: string) => Promise<string>,
): Promise<JobScheduler> {
  const boss = new PgBoss({
    connectionString: systemUrl,
    schema: QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
  });
  boss.on('error', (error) => console.error('pg-boss', error.message));
  await boss.start();
  for (const job of JOB_CATALOGUE) {
    const time = await timeOf(job.parameterKey, job.defaultTime);
    await boss.schedule(job.key, dailyCron(time), null, { tz: BUSINESS_TIME_ZONE });
    await boss.work(job.key, async () => {
      const outcome = await runJob(deps, job.key, realClock.today());
      if (outcome === 'failed') throw new Error(`Job ${job.key} failed`);
    });
  }
  return { stop: () => boss.stop({ graceful: true }) };
}
