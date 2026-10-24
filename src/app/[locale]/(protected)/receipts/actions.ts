'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { recordReceipt } from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission receipts.write (plant, owner, partner): the result carries no amount
export async function receiveAction(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('receipts.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await recordReceipt(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
