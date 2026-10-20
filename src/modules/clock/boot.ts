import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { realClock } from './service/clock';
import { syncSimClock } from './service/sim-clock';

/** Same fixed actor id as platform-security's SYSTEM_ACTOR_ID (clock imports no other module). */
const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000002';

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
