'use server';

import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import {
  type AdvanceActionResult,
  type AdvanceInput,
  advanceClock,
  casablancaInstant,
  MAX_ADVANCE_DAYS,
  stubJobRegistry,
} from '@/modules/clock';
import type { BusinessDate } from '@/modules/clock';
import { authorize } from '@/modules/platform-security/auth/guards';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { withStepUp } from '@/modules/platform-security/auth/step-up-guard';
import { readParameters } from '@/modules/platform-security/service/parameter-service';
import { jobTimeOf } from './job-time-of';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// @permission simulation.control (owner) + sensitive action clock.advance
export async function advanceClockAction(input: AdvanceInput): Promise<AdvanceActionResult> {
  const simulationEnabled = getEnv().SIMULATION_ENABLED;
  if (!simulationEnabled) return { ok: false, error: 'FORBIDDEN' };
  const allowed = await authorize('simulation.control', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  try {
    const result = await withStepUp(
      'clock.advance',
      async (user) => {
        const appPool = getPool('app');
        const target =
          'byDays' in input
            ? Number.isInteger(input.byDays) && input.byDays >= 1 && input.byDays <= MAX_ADVANCE_DAYS
              ? { byDays: input.byDays }
              : null
            : DATE.test(input.toDate) && TIME.test(input.toTime)
              ? { to: casablancaInstant(input.toDate as BusinessDate, input.toTime) }
              : null;
        if (!target) return { invalid: true as const };
        return advanceClock(
          {
            simulationEnabled,
            appPool,
            systemPool: getPool('system'),
            registry: stubJobRegistry(),
            timeOf: jobTimeOf,
          },
          { userId: user.id, role: 'owner' },
          target,
        );
      },
      { getState: currentAuthState, parameters: () => readParameters(getPool('auth')) },
    );
    if (!result.ok) return { ok: false, error: result.error };
    if ('invalid' in result.value) return { ok: false, error: 'INVALID' };
    const failed = result.value.ran.find((r) => r.outcome === 'failed');
    return { ok: true, ...(failed && { failedJob: failed.jobKey }) };
  } catch {
    return { ok: false, error: 'INVALID' };
  }
}
