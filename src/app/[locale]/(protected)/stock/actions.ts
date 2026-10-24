'use server';

import { getPool } from '@/lib/db/pools';
import { setStockThreshold } from '@/modules/operations';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission stock.threshold (owner, partner)
export async function thresholdAction(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('stock.threshold', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await setStockThreshold(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
