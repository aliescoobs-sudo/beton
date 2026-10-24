'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  cancelPurchase,
  type CancelPurchaseError,
  createPurchase,
  type Effect,
  type PurchaseError,
} from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = {
  ok: false;
  error:
    | PurchaseError
    | CancelPurchaseError
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'STEP_UP_REQUIRED'
    | 'REENROL_REQUIRED';
};

// @permission purchases.write (owner, office): blind entry, the result carries the code and the effects the role may see
export async function createPurchaseAction(
  input: unknown,
): Promise<{ ok: true; code: string; effects: Effect[] } | Failure> {
  const allowed = await authorize('purchases.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createPurchase(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, code: result.value.code, effects: result.value.effects ?? [] } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission ledger.reverse (owner) + sensitive action ledger.reverse_entry
export async function cancelPurchaseAction(
  purchaseId: string,
  reason: string,
): Promise<{ ok: true; number: string } | Failure> {
  const allowed = await authorize('ledger.reverse', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const result = await withStepUp(
      'ledger.reverse_entry',
      (user) => cancelPurchase(getPool('app'), user, purchaseId, reason, { today }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true, number: result.value.value.code } : result.value;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
