import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import type { BusinessDate } from '../domain/business-date';
import { JOB_CATALOGUE, type JobKey } from '../domain/job-catalogue';
import { SYSTEM_ACTOR_ID } from '../domain/system-actor';
import type { Clock } from './clock';
import { getLogger } from './logger';

export interface JobContext {
  jobKey: string;
  businessDate: BusinessDate;
  /** Transaction of the run: the 'system' actor, so every write is audited with actor_kind = system. */
  tx: pg.PoolClient;
}

export type JobHandler = (context: JobContext) => Promise<void>;
export type JobRegistry = ReadonlyMap<string, JobHandler>;

/** Logged no-ops until the owning modules exist (T23). */
export function stubJobRegistry(): Map<JobKey, JobHandler> {
  return new Map(
    JOB_CATALOGUE.map(({ key }) => [
      key,
      async ({ businessDate }: JobContext) => {
        getLogger().info('job stub ran', { job: key, businessDate });
      },
    ]),
  );
}

export type JobRunOutcome = 'ran' | 'skipped' | 'failed';

export interface JobRunnerDeps {
  /** Pool of the belgobeton_system role. */
  pool: pg.Pool;
  registry: JobRegistry;
  /** Business time for `ran_at`/`sim_at`: a request clock in simulated mode. */
  clock: Clock & { readonly simulated?: boolean };
  /** Real wall time for `ran_at` (defaults to `clock`). */
  realNow?: () => Date;
}

/**
 * Runs `jobKey` for `businessDate` at most once (AC-CLK-03, idempotency). The claim row, the handler's writes and the
 * final status commit together as the 'system' actor. A concurrent second runner blocks on the unique key and then
 * skips. A failed run rolls everything back, is recorded as 'failed', and may be run again.
 */
export async function runJob(
  deps: JobRunnerDeps,
  jobKey: string,
  businessDate: BusinessDate,
): Promise<JobRunOutcome> {
  const handler = deps.registry.get(jobKey);
  if (!handler) throw new Error(`Unknown job "${jobKey}"`);
  const ranAt = (deps.realNow ?? deps.clock.now)();
  const simAt = deps.clock.simulated ? deps.clock.now() : null;
  const ctx = { userId: SYSTEM_ACTOR_ID, role: 'system' as const, requestId: uuidv7(ranAt) };

  try {
    return await withRlsContext(deps.pool, ctx, async (tx) => {
      const claim = await tx.query(
        `insert into scheduled_job_run (id, job_key, business_date, status, ran_at, sim_at, run_by)
         values ($1, $2, $3, 'running', $4, $5, $6)
         on conflict (job_key, business_date) do update
           set status = 'running', ran_at = excluded.ran_at, sim_at = excluded.sim_at, error = null
           where scheduled_job_run.status = 'failed'
         returning id`,
        [uuidv7(ranAt), jobKey, businessDate, ranAt, simAt, SYSTEM_ACTOR_ID],
      );
      if (claim.rowCount === 0) return 'skipped';
      await handler({ jobKey, businessDate, tx });
      await tx.query(
        `update scheduled_job_run set status = 'succeeded' where job_key = $1 and business_date = $2`,
        [jobKey, businessDate],
      );
      return 'ran';
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error('job failed', { job: jobKey, businessDate, error: message });
    await withRlsContext(deps.pool, { ...ctx, requestId: uuidv7(ranAt) }, (tx) =>
      tx.query(
        `insert into scheduled_job_run (id, job_key, business_date, status, ran_at, sim_at, run_by, error)
         values ($1, $2, $3, 'failed', $4, $5, $6, $7)
         on conflict (job_key, business_date) do update set status = 'failed', error = excluded.error,
           ran_at = excluded.ran_at, sim_at = excluded.sim_at
           where scheduled_job_run.status <> 'succeeded'`,
        [uuidv7(ranAt), jobKey, businessDate, ranAt, simAt, SYSTEM_ACTOR_ID, message.slice(0, 500)],
      ),
    );
    return 'failed';
  }
}
