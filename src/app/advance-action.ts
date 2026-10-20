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
import { recordClockAdvance } from '@/modules/platform-security/service/clock-audit';
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

  const appPool = getPool('app');
  let ownerId: string | undefined;
  try {
    const result = await withStepUp(
      'clock.advance',
      async (user) => {
        ownerId = user.id;
        const advanced = await advanceClock(
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
        const failedJob = advanced.ran.find((r) => r.outcome === 'failed')?.jobKey;
        await recordClockAdvance(appPool, user.id, {
          from: advanced.from,
          to: advanced.to,
          requested: input,
          outcome: failedJob ? 'job_failed' : 'advanced',
          failedJob,
        });
        return { failedJob };
      },
      { getState: currentAuthState, parameters: () => readParameters(getPool('auth')) },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, ...(result.value.failedJob && { failedJob: result.value.failedJob }) };
  } catch (error) {
    const rejected = error instanceof AdvanceRejectedError;
    const disabled = error instanceof SimulationDisabledError;
    const detail = error instanceof Error ? error.message : String(error);
    if (ownerId) {
      // Best effort: the refusal itself must reach the owner even if the audit write fails too.
      await recordClockAdvance(appPool, ownerId, {
        requested: input,
        outcome: rejected || disabled ? 'rejected' : 'error',
        detail,
      }).catch((auditError) =>
        getLogger().error('clock advance audit failed', { error: String(auditError) }),
      );
    }
    if (disabled) return { ok: false, error: 'SIMULATION_DISABLED' };
    if (rejected) return { ok: false, error: error.reason };
    getLogger().error('clock advance failed', { error: detail });
    return { ok: false, error: 'SERVER_ERROR' };
  }
}
