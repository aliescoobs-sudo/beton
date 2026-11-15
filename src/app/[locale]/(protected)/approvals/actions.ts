'use server';

import { getPool } from '@/lib/db/pools';
import { confirmOrderPrice, confirmPricesInBulk, decidePayment, releaseOrderHold } from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: string };

async function decide<T>(
  action: 'prices.confirm' | 'orders.release_hold' | 'payments.approve',
  run: (
    user: Parameters<typeof confirmOrderPrice>[1],
  ) => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
): Promise<{ ok: true } | Failure> {
  const allowed = await authorize('approvals.decide', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(action, (user) => run(user), { getState: currentAuthState });
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission approvals.decide (owner, app_admin) + sensitive action prices.confirm: one order's real price (or the reference price as it is)
export async function confirmPriceAction(input: unknown): Promise<{ ok: true } | Failure> {
  return decide('prices.confirm', (user) => confirmOrderPrice(getPool('app'), user, input));
}

// @permission approvals.decide (owner, app_admin) + sensitive action prices.confirm: several orders at their reference price, all or none
export async function confirmPricesBulkAction(orderIds: unknown): Promise<{ ok: true } | Failure> {
  return decide('prices.confirm', (user) => confirmPricesInBulk(getPool('app'), user, orderIds));
}

// @permission approvals.decide (owner, app_admin) + sensitive action orders.release_hold: lets a held order be loaded
export async function releaseHoldAction(input: unknown): Promise<{ ok: true } | Failure> {
  const i = (input ?? {}) as { orderId?: string; note?: string };
  return decide('orders.release_hold', (user) =>
    releaseOrderHold(getPool('app'), user, { orderId: String(i.orderId), note: i.note ?? null }),
  );
}

// @permission approvals.decide (owner, app_admin) + sensitive action payments.approve: approve or reject an outgoing payment above the upper limit (the door refuses the preparer)
export async function decidePaymentApprovalAction(input: unknown): Promise<{ ok: true } | Failure> {
  const i = (input ?? {}) as { id?: unknown; decision?: unknown };
  // only the owner's two decisions are offered here; validating the middle band stays with the Responsable on the request page
  if (i.decision !== 'approve' && i.decision !== 'reject') return { ok: false, error: 'INVALID' };
  return decide('payments.approve', (user) =>
    decidePayment(getPool('app'), user, { id: i.id, decision: i.decision }),
  );
}
