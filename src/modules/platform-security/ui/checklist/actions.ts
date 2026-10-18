'use server';

import { getPool } from '@/lib/db/pools';
import { realClock } from '@/modules/clock';
import { authorize } from '../../auth/guards';
import { currentAuthState } from '../../auth/request-state';
import { withStepUp } from '../../auth/step-up-guard';
import { CHECKLIST, type ChecklistKey } from '../../domain/checklist';
import { markChecklistItem } from '../../service/checklist';
import { readParameters } from '../../service/parameter-service';

export type ChecklistActionResult =
  | { ok: true }
  | {
      ok: false;
      error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED' | 'INVALID';
      message?: string;
    };

// @permission checklist.manage (owner) + sensitive action checklist.mark
export async function markChecklistItemAction(
  key: unknown,
  evidence: unknown,
): Promise<ChecklistActionResult> {
  if (typeof key !== 'string' || !Object.hasOwn(CHECKLIST, key) || typeof evidence !== 'string') {
    return { ok: false, error: 'INVALID' };
  }
  const allowed = await authorize('checklist.manage', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'checklist.mark',
      (user) =>
        markChecklistItem(getPool('app'), user, key as ChecklistKey, evidence, {
          systemPool: getPool('system'),
          authPool: getPool('auth'),
          clock: realClock,
        }),
      { getState: currentAuthState, parameters: () => readParameters(getPool('auth')) },
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: 'INVALID', message: error instanceof Error ? error.message : undefined };
  }
}
