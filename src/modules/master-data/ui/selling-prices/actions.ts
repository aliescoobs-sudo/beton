'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import {
  createClientOverride,
  createListPrice,
  type SellingPriceError,
} from '../../service/selling-price-service';

export type SellingPriceActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | SellingPriceError };

// @permission selling_prices.write (owner, partner)
export async function createListPriceAction(input: unknown): Promise<SellingPriceActionResult> {
  const allowed = await authorize('selling_prices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createListPrice(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission client_price_override.write (owner, partner)
export async function createClientOverrideAction(input: unknown): Promise<SellingPriceActionResult> {
  const allowed = await authorize('client_price_override.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createClientOverride(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
