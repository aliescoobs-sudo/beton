'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { type InstrumentError, issueInstrument, receiveInstrument } from '@/modules/ledger';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

export type PaymentActionResult =
  { ok: true } | { ok: false; error: InstrumentError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

async function guarded(
  run: (user: Parameters<typeof receiveInstrument>[1], today: string) => ReturnType<typeof receiveInstrument>,
): Promise<PaymentActionResult> {
  const allowed = await authorize('instruments.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user, (await getRequestClock()).today());
    // Blind entry: the answer carries no id and no amount, only the outcome.
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission instruments.write (owner, office): blind entry, the result carries no amount
export async function receivePaymentAction(input: unknown): Promise<PaymentActionResult> {
  return guarded((user, today) => receiveInstrument(getPool('app'), user, input, { today }));
}

// @permission instruments.write (owner, office): blind entry, the result carries no amount
export async function issuePaymentAction(input: unknown): Promise<PaymentActionResult> {
  return guarded((user, today) => issueInstrument(getPool('app'), user, input, { today }));
}
