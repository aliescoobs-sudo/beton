import { cache } from 'react';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { loadRequestClock } from '@/modules/clock';

/** The clock for the current request: `sim_now` is read at most once per request (React cache). */
export const getRequestClock = cache(() => loadRequestClock(getPool('auth'), getEnv().SIMULATION_ENABLED));
