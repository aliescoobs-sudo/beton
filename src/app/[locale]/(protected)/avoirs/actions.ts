'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { type AvoirError, type Effect, issueAvoir } from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Result =
  | { ok: true; number: string; effects: Effect[] }
  | {
      ok: false;
      error: AvoirError | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED';
    };

// @permission avoirs.issue (owner) + sensitive action ledger.credit_note: the avoir of concrete refused or brought back after billing
export async function issueAvoirAction(input: unknown): Promise<Result> {
  const allowed = await authorize('avoirs.issue', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const result = await withStepUp(
      'ledger.credit_note',
      (user) => issueAvoir(getPool('app'), user, input, { today }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok
      ? { ok: true, number: result.value.value.number, effects: result.value.value.effects }
      : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
