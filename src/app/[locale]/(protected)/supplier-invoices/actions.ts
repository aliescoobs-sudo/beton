'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  acceptSupplierInvoiceGaps,
  approveSupplierInvoice,
  createSupplierInvoice,
  type DecisionError,
  type Effect,
  rejectSupplierInvoice,
  type SupplierInvoiceError,
} from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = { ok: false; error: SupplierInvoiceError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

// @permission supplier_invoices.write (owner, office): blind entry, the answer is our code and the effects the role may see
export async function createSupplierInvoiceAction(
  input: unknown,
): Promise<{ ok: true; code: string; effects: Effect[] } | Failure> {
  const allowed = await authorize('supplier_invoices.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createSupplierInvoice(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, code: result.value.code, effects: result.value.effects } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

type DecisionResult =
  | { ok: true; effects?: Effect[] }
  | {
      ok: false;
      error: DecisionError | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED';
    };

// @permission supplier_invoices.approve (owner) + sensitive action purchases.approve_invoice: accepts the gaps, with a reason (audited)
export async function acceptGapsAction(input: unknown): Promise<DecisionResult> {
  const allowed = await authorize('supplier_invoices.approve', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'purchases.approve_invoice',
      (user) => acceptSupplierInvoiceGaps(getPool('app'), user, input),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission supplier_invoices.approve (owner) + sensitive action purchases.approve_invoice: approve for payment, creating the payable
export async function approveAction(input: unknown): Promise<DecisionResult> {
  const allowed = await authorize('supplier_invoices.approve', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'purchases.approve_invoice',
      (user) => approveSupplierInvoice(getPool('app'), user, input),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok
      ? { ok: true, effects: result.value.value.effects }
      : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission supplier_invoices.approve (owner): rejects an invoice not approved yet, with a reason
export async function rejectAction(input: unknown): Promise<DecisionResult> {
  const allowed = await authorize('supplier_invoices.approve', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await rejectSupplierInvoice(getPool('app'), allowed.user, input);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
