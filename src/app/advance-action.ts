'use server';

import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import {
  type AdvanceActionResult,
  advanceClock,
  AdvanceRejectedError,
  getLogger,
  parseAdvanceInput,
  SimulationDisabledError,
  stubJobRegistry,
} from '@/modules/clock';
import { authorize } from '@/modules/platform-security/auth/guards';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { withStepUp } from '@/modules/platform-security/auth/step-up-guard';
import { readParameters } from '@/modules/platform-security/service/parameter-service';
import { jobTimeOf } from './job-time-of';

// @permission simulation.control (owner) + sensitive action clock.advance
export async function advanceClockAction(input: unknown): Promise<AdvanceActionResult> {
  const simulationEnabled = getEnv().SIMULATION_ENABLED;
  if (!simulationEnabled) return { ok: false, error: 'SIMULATION_DISABLED' };
  const allowed = await authorize('simulation.control', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  // Validate before asking for a second factor: a malformed request must not cost the owner a TOTP prompt.
  const target = parseAdvanceInput(input);
  if (!target) return { ok: false, error: 'INVALID' };

  try {
    const result = await withStepUp(
      'clock.advance',
      (user) =>
        advanceClock(
          {
            simulationEnabled,
            appPool: getPool('app'),
            systemPool: getPool('system'),
            registry: stubJobRegistry(),
            timeOf: jobTimeOf,
          },
          { userId: user.id, role: 'owner' },
          target,
        ),
      { getState: currentAuthState, parameters: () => readParameters(getPool('auth')) },
    );
    if (!result.ok) return { ok: false, error: result.error };
    const failed = result.value.ran.find((r) => r.outcome === 'failed');
    return { ok: true, ...(failed && { failedJob: failed.jobKey }) };
  } catch (error) {
    if (error instanceof SimulationDisabledError) return { ok: false, error: 'SIMULATION_DISABLED' };
    if (error instanceof AdvanceRejectedError) return { ok: false, error: error.reason };
    getLogger().error('clock advance failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: 'SERVER_ERROR' };
  }
}
