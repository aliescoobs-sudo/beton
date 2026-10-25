'use server';

import { getPool } from '@/lib/db/pools';
import { getRequestClock } from '@/app/request-clock';
import { adjustStockAfterCount, setStockThreshold } from '@/modules/operations';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
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

// @permission stock.count (owner) + sensitive action stock.adjust: one correcting movement with the owner's reason
export async function countAction(
  input: unknown,
): Promise<{ ok: true; before: number; counted: number; difference: number } | { ok: false; error: string }> {
  const allowed = await authorize('stock.count', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const result = await withStepUp(
      'stock.adjust',
      (user) => adjustStockAfterCount(getPool('app'), user, input, { today }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok
      ? {
          ok: true,
          before: result.value.value.before,
          counted: result.value.value.counted,
          difference: result.value.value.difference,
        }
      : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
