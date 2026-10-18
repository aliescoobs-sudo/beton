'use server';

import { getPool } from '@/lib/db/pools';
import { authorize } from '../../auth/guards';
import { currentAuthState } from '../../auth/request-state';
import { withStepUp } from '../../auth/step-up-guard';
import { isParameterKey } from '../../domain/parameters';
import { readParameters, setParameter } from '../../service/parameter-service';

export type ParameterActionResult =
  | { ok: true }
  | {
      ok: false;
      error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED' | 'INVALID';
    };

// @permission parameters.write (owner) + sensitive action parameters.change
export async function setParameterAction(key: unknown, value: unknown): Promise<ParameterActionResult> {
  if (typeof key !== 'string' || !isParameterKey(key)) return { ok: false, error: 'INVALID' };
  const allowed = await authorize('parameters.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'parameters.change',
      (user) => setParameter(getPool('app'), user, key, value),
      {
        getState: currentAuthState,
        parameters: () => readParameters(getPool('auth')),
      },
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch {
    return { ok: false, error: 'INVALID' };
  }
}
