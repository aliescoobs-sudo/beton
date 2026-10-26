'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  allocateToInvoice,
  bounceInstrument,
  cancelInstrument,
  clearInstrument,
  depositInstruments,
  disputeInstrument,
  type InstrumentError,
  regularizeInstrument,
} from '@/modules/ledger';
import { authorize, ForbiddenError, type SessionUser, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

export type LifecycleResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | InstrumentError
        | 'UNAUTHENTICATED'
        | 'FORBIDDEN'
        | 'STEP_UP_REQUIRED'
        | 'REENROL_REQUIRED'
        | 'FUTURE_DATE';
    };

type Run = (user: SessionUser) => Promise<{ ok: true } | { ok: false; error: InstrumentError }>;

/** Every lifecycle action is the owner's (`instruments.manage`); the ones that undo money also need a fresh second factor. */
async function guarded(input: unknown, run: Run, sensitive: boolean): Promise<LifecycleResult> {
  const allowed = await authorize('instruments.manage', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const date = (input as { date?: unknown } | null)?.date;
  if (typeof date === 'string' && date > (await getRequestClock()).today())
    return { ok: false, error: 'FUTURE_DATE' };
  try {
    if (sensitive) {
      const result = await withStepUp('ledger.reverse_entry', run, { getState: currentAuthState });
      if (!result.ok)
        return { ok: false, error: result.error === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : result.error };
      return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
    }
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission instruments.manage (owner)
export async function depositAction(input: unknown): Promise<LifecycleResult> {
  return guarded(input, (user) => depositInstruments(getPool('app'), user, input), false);
}

// @permission instruments.manage (owner)
export async function clearAction(input: unknown): Promise<LifecycleResult> {
  return guarded(input, (user) => clearInstrument(getPool('app'), user, input), false);
}

// @permission instruments.manage (owner) + sensitive action ledger.reverse_entry (undoes the coverage of the items)
export async function bounceAction(input: unknown): Promise<LifecycleResult> {
  return guarded(input, (user) => bounceInstrument(getPool('app'), user, input), true);
}

// @permission instruments.manage (owner)
export async function regularizeAction(input: unknown): Promise<LifecycleResult> {
  return guarded(input, (user) => regularizeInstrument(getPool('app'), user, input), false);
}

// @permission instruments.manage (owner)
export async function disputeAction(input: unknown): Promise<LifecycleResult> {
  return guarded(input, (user) => disputeInstrument(getPool('app'), user, input), false);
}

// @permission instruments.manage (owner) + sensitive action ledger.reverse_entry
export async function cancelAction(input: unknown): Promise<LifecycleResult> {
  return guarded(input, (user) => cancelInstrument(getPool('app'), user, input), true);
}

// @permission instruments.manage (owner): directs (part of) a payment to one invoice, with a reason; the rows keep it (audited)
export async function allocateToInvoiceAction(
  input: unknown,
): Promise<{ ok: true; allocatedCentimes: number } | { ok: false; error: string }> {
  const allowed = await authorize('instruments.manage', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await allocateToInvoice(getPool('app'), allowed.user, input);
    return result.ok
      ? { ok: true, allocatedCentimes: result.value.allocatedCentimes }
      : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
