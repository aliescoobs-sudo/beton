'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import type { Effect } from '@/modules/ledger';
import { confirmArrivalAtPlant, recordReceipt } from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission receipts.write (plant, owner, partner): the result carries the effects the role may see, no amount
export async function receiveAction(
  input: unknown,
): Promise<{ ok: true; effects: Effect[] } | { ok: false; error: string }> {
  const allowed = await authorize('receipts.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await recordReceipt(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, effects: result.value.effects } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission receipts.confirm_arrival (plant, owner, partner): the first step of the two-step receipt, no quantity, no price
export async function confirmArrivalAction(input: {
  purchaseId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('receipts.confirm_arrival', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await confirmArrivalAtPlant(getPool('app'), allowed.user, {
      purchaseId: String(input.purchaseId),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
