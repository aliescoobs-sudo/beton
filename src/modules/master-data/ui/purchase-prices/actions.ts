'use server';

import { getPool } from '@/lib/db/pools';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import {
  createPurchasePrice,
  proposePriceFromLastPurchase,
  type PurchasePriceError,
} from '../../service/purchase-price-service';

export type PurchasePriceActionResult =
  { ok: true } | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' | PurchasePriceError };

// @permission purchase_prices.write (owner, partner)
export async function createPurchasePriceAction(input: unknown): Promise<PurchasePriceActionResult> {
  const allowed = await authorize('purchase_prices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createPurchasePrice(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

export type ProposalResult =
  | { ok: true; proposal: { supplierId: string; purchaseUnitId: string; priceHtCentimes: number } | null }
  | { ok: false; error: 'UNAUTHENTICATED' | 'FORBIDDEN' };

// @permission purchase_prices.write (owner, partner)
export async function proposePriceAction(componentId: unknown): Promise<ProposalResult> {
  const allowed = await authorize('purchase_prices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  if (typeof componentId !== 'string') return { ok: true, proposal: null };
  const last = await proposePriceFromLastPurchase(getPool('app'), allowed.user, componentId);
  return {
    ok: true,
    proposal: last && {
      supplierId: last.supplierId,
      purchaseUnitId: last.purchaseUnitId,
      priceHtCentimes: last.priceHtCentimes,
    },
  };
}
