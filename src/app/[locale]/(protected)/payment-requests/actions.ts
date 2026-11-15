'use server';

import { revalidatePath } from 'next/cache';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  decidePayment,
  issueInstrument,
  listPaymentRequests,
  preparePayment,
  type PaymentControlError,
} from '@/modules/ledger';
import { authorize, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

type Answer =
  | { ok: true }
  | {
      ok: false;
      error:
        | PaymentControlError
        | 'UNAUTHENTICATED'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'CONTROL_REQUIRED'
        | 'INVALID'
        | 'REENROL_REQUIRED';
    };

// @permission payments.prepare (owner, app_admin, office_purchases): prepare an outgoing payment (nothing is issued)
export async function preparePaymentAction(input: unknown): Promise<Answer> {
  const allowed = await authorize('payments.prepare', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const r = await preparePayment(getPool('app'), allowed.user, input);
  if (!r.ok) return r;
  revalidatePath('/[locale]/payment-requests', 'page');
  return { ok: true };
}

// @permission payments.decide (owner, app_admin, office_sales): validate, approve or reject; a different user from the preparer (the door)
export async function decidePaymentAction(input: unknown): Promise<Answer> {
  const allowed = await authorize('payments.decide', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  let r = await decidePayment(getPool('app'), allowed.user, input);
  // T19c A: the database door asks for the fresh second factor on an approval above the upper limit (below it nothing changes); the same
  // decision is then run again behind the step-up, and a stale factor goes back to the page as STEP_UP_REQUIRED (the dialog opens, the page retries).
  if (!r.ok && r.error === 'STEP_UP_REQUIRED') {
    const guarded = await withStepUp(
      'payments.approve',
      (user) => decidePayment(getPool('app'), user, input),
      { getState: currentAuthState },
    );
    if (!guarded.ok) return { ok: false, error: guarded.error };
    r = guarded.value;
  }
  if (!r.ok) return r;
  revalidatePath('/[locale]/payment-requests', 'page');
  return { ok: true };
}

// @permission instruments.write (owner, app_admin, office, office_purchases): issue the payment of a validated request (the trigger of 0245 checks it again)
export async function issueRequestedPaymentAction(input: { requestId: string }): Promise<Answer> {
  const allowed = await authorize('instruments.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const pool = getPool('app');
  const request = (await listPaymentRequests(pool, allowed.user)).find((r) => r.id === input.requestId);
  if (!request) return { ok: false, error: 'NOT_FOUND' };
  const today = (await getRequestClock()).today();
  const r = await issueInstrument(
    pool,
    allowed.user,
    {
      supplierId: request.supplierId,
      method: request.method,
      amountCentimes: request.amountCentimes,
      number: request.number,
      bank: request.bank,
      writtenDate: request.writtenDate,
    },
    { today, requestId: request.id },
  );
  if (!r.ok) return { ok: false, error: r.error === 'CONTROL_REQUIRED' ? 'CONTROL_REQUIRED' : 'INVALID' };
  revalidatePath('/[locale]/payment-requests', 'page');
  return { ok: true };
}
