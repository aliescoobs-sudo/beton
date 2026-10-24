'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  type CancelInvoiceError,
  cancelInvoice,
  createInvoice,
  type Effect,
  type InvoiceError,
} from '@/modules/ledger';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Failure = {
  ok: false;
  error:
    | InvoiceError
    | CancelInvoiceError
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'STEP_UP_REQUIRED'
    | 'REENROL_REQUIRED';
};

// @permission invoices.write (owner, office): blind entry, the result carries the number and the effects the role may see
export async function createInvoiceAction(
  input: unknown,
): Promise<{ ok: true; number: string; effects: Effect[] } | Failure> {
  const allowed = await authorize('invoices.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createInvoice(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, number: result.value.number, effects: result.value.effects } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission ledger.reverse (owner) + sensitive action ledger.reverse_entry: a credit note undoes an invoice
export async function cancelInvoiceAction(
  invoiceId: string,
  reason: string,
): Promise<{ ok: true; number: string; effects: Effect[] } | Failure> {
  const allowed = await authorize('ledger.reverse', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const result = await withStepUp(
      'ledger.reverse_entry',
      (user) => cancelInvoice(getPool('app'), user, invoiceId, reason, { today }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok
      ? { ok: true, number: result.value.value.number, effects: result.value.value.effects }
      : result.value;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
