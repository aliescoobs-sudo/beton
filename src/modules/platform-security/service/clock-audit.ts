import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { recordAuditEvent } from './audit-service';

export interface ClockAdvanceRecord {
  /** `sim_now` before the advance (absent when it could not be read). */
  from?: Date;
  /** `sim_now` after it: the target, or the instant of a failed job. */
  to?: Date;
  /** What the owner asked for, in the action's own terms. */
  requested: unknown;
  outcome: 'advanced' | 'job_failed' | 'rejected' | 'error';
  failedJob?: string;
  detail?: string;
}

/**
 * One `clock_advance` audit event per advance request, with from/to (AC-CLK-06). It is written by the owner's own
 * request context, after the step-up check passed, whatever the outcome; the per-step `sim_clock` rows come from the
 * capture trigger and tell the same story in finer detail.
 */
export async function recordClockAdvance(
  appPool: pg.Pool,
  ownerId: string,
  record: ClockAdvanceRecord,
): Promise<void> {
  await withRlsContext(
    appPool,
    { userId: ownerId, role: 'owner', requestId: uuidv7(realClock.now()) },
    (tx) =>
      recordAuditEvent(tx, {
        action: 'clock_advance',
        table: 'sim_clock',
        before: { sim_now: record.from?.toISOString() ?? null },
        after: {
          sim_now: record.to?.toISOString() ?? null,
          requested: record.requested as Record<string, unknown>,
          outcome: record.outcome,
          ...(record.failedJob && { failed_job: record.failedJob }),
        },
        reason: record.detail,
      }),
  );
}
