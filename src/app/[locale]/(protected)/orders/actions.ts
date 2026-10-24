'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { cancelOrder, type CancelOrderError } from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Result =
  | { ok: true; number: string }
  | {
      ok: false;
      error: CancelOrderError | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED';
    };

// @permission ledger.reverse (owner) + sensitive action ledger.reverse_entry: a cancellation undoes the order and its plan
export async function cancelOrderAction(orderId: string, reason: string): Promise<Result> {
  const allowed = await authorize('ledger.reverse', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const result = await withStepUp(
      'ledger.reverse_entry',
      (user) => cancelOrder(getPool('app'), user, orderId, reason, {}, { today }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true, number: result.value.value.reversal.code } : result.value;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
