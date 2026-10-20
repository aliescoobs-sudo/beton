import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { SYSTEM_ACTOR_ID } from './domain/system-actor';
import { realClock } from './service/clock';
import { stubJobRegistry } from './service/job-runner';
import { startJobScheduler } from './service/job-scheduler';
import { syncSimClock } from './service/sim-clock';

/**
 * Node-only: make the simulated-clock singleton match SIMULATION_ENABLED (the env guard has already run).
 * Enabling must succeed or the server stops. Disabling is best effort: the database may not be migrated yet
 * (first start, e2e), and a missing table means there is no simulated clock to switch off.
 */
export async function syncSimClockOrExit(): Promise<void> {
  const enabled = getEnv().SIMULATION_ENABLED;
  try {
    await syncSimClock(getPool('system'), enabled, SYSTEM_ACTOR_ID, realClock.now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (enabled) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`Could not reset the simulated clock to real mode: ${message}`);
  }
}

/**
 * Node-only, real mode only: schedule the catalogue jobs. `timeOf` supplies the configured job times (read once at
 * boot; a changed parameter applies at the next restart). Simulated mode never schedules: `advance` drives jobs.
 */
export async function startJobSchedulerOrExit(
  timeOf: (parameterKey: string, defaultTime: string) => Promise<string>,
): Promise<void> {
  if (getEnv().SIMULATION_ENABLED || getEnv().JOB_SCHEDULER_DISABLED) return;
  try {
    await startJobScheduler(
      getEnv().DATABASE_URL_SYSTEM,
      { pool: getPool('system'), clock: realClock, registry: stubJobRegistry() },
      timeOf,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
