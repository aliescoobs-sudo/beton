import type pg from 'pg';
import { type BusinessDate, businessDateOf } from '../domain/business-date';
import { jobInstantsBetween, type ScheduledJobTime } from '../domain/instants';
import { JOB_CATALOGUE } from '../domain/job-catalogue';
import { type JobHandler, type JobRegistry, type JobRunOutcome, runJob, unfinishedRuns } from './job-runner';
import { readSimNow, type SimClockActor, setSimNow } from './sim-clock';

export type AdvanceTarget = { to: Date } | { byDays: number };

/**
 * A scripted event of the `simulation` module: runs at `at`, between the jobs, as part of the advance. It is
 * recorded like a job (`event-<key>` per business date), so it runs once, in the 'system' transaction.
 */
export interface ScriptedEvent {
  /** Unique per event, stable across advances. */
  key: string;
  at: Date;
  run: JobHandler;
}

export interface AdvanceDeps {
  simulationEnabled: boolean;
  /** Pool that writes `sim_now` as the owner (belgobeton_app). */
  appPool: pg.Pool;
  /** Pool of the belgobeton_system role, used by the jobs. */
  systemPool: pg.Pool;
  registry: JobRegistry;
  /** Configured `HH:MM` of a catalogue job. */
  timeOf: (parameterKey: string, defaultTime: string) => Promise<string>;
  /** Hook for the `simulation` module: events due in (from, to]. */
  scriptedEvents?: (from: Date, to: Date) => Promise<readonly ScriptedEvent[]>;
  realNow?: () => Date;
}

export interface AdvanceResult {
  from: Date;
  /** Where `sim_now` ended: the target, or the instant of a failed job. */
  to: Date;
  ran: { jobKey: string; businessDate: BusinessDate; outcome: JobRunOutcome }[];
  failed: boolean;
}

type Step = { at: Date; jobKey: string; businessDate: BusinessDate; run?: JobHandler };

export const MAX_ADVANCE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Moves the simulated clock to the target, running every job instant and scripted event crossed, in order, each at
 * its own instant and to completion. Re-running a crossed instant is a no-op (`runJob`), so 3 days ≡ 3 × 1 day
 * (AC-CLK-03/04). A failed job stops the advance at that instant. Authorization (owner + step-up) is the caller's job.
 */
export async function advanceClock(
  deps: AdvanceDeps,
  actor: SimClockActor,
  target: AdvanceTarget,
): Promise<AdvanceResult> {
  const realNow = deps.realNow ?? (() => new Date());
  const from = await readSimNow(deps.appPool, deps.simulationEnabled, actor);
  const to = 'to' in target ? target.to : new Date(from.getTime() + target.byDays * DAY_MS);
  if (!(to.getTime() > from.getTime())) throw new Error('sim_now can only move forward');
  if (to.getTime() - from.getTime() > MAX_ADVANCE_DAYS * DAY_MS) {
    throw new Error(`Cannot advance by more than ${MAX_ADVANCE_DAYS} days at once`);
  }

  const times: ScheduledJobTime[] = [];
  for (const job of JOB_CATALOGUE) {
    times.push({ jobKey: job.key, time: await deps.timeOf(job.parameterKey, job.defaultTime) });
  }
  // The range starts just before `from`: a step at `from` whose last run failed is offered again (the clock stopped
  // there); any other step at `from` is not.
  const lookback = new Date(from.getTime() - 1);
  const candidates: Step[] = [
    ...jobInstantsBetween(lookback, to, times),
    ...((await deps.scriptedEvents?.(lookback, to)) ?? []).map((event): Step => ({
      at: event.at,
      jobKey: `event-${event.key}`,
      businessDate: businessDateOf(event.at),
      run: event.run,
    })),
  ];
  const retry = await unfinishedRuns(
    deps.systemPool,
    candidates.filter((c) => c.at.getTime() === from.getTime()),
  );
  const steps = candidates
    .filter((c) => c.at.getTime() > from.getTime() || retry.has(`${c.jobKey}|${c.businessDate}`))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const result: AdvanceResult = { from, to, ran: [], failed: false };
  let current = from;
  for (const step of steps) {
    if (step.at.getTime() > current.getTime()) {
      await setSimNow(deps.appPool, true, actor, step.at, realNow());
      current = step.at;
    }
    const at = step.at;
    const outcome = await runJob(
      {
        pool: deps.systemPool,
        registry: step.run ? new Map([[step.jobKey, step.run]]) : deps.registry,
        clock: { now: () => new Date(at), today: () => businessDateOf(at), simulated: true },
        realNow,
      },
      step.jobKey,
      step.businessDate,
    );
    result.ran.push({ jobKey: step.jobKey, businessDate: step.businessDate, outcome });
    if (outcome === 'failed') {
      result.failed = true;
      result.to = current;
      return result;
    }
  }
  if (to.getTime() > current.getTime()) await setSimNow(deps.appPool, true, actor, to, realNow());
  return result;
}
