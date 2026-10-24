'use server';

import { getPool } from '@/lib/db/pools';
import { addPartyOpeningBalance, enterOpeningDate, type OpeningError } from '@/modules/ledger';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

export type OpeningActionResult =
  { ok: true } | { ok: false; error: OpeningError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

async function guarded(
  run: (
    user: Parameters<typeof enterOpeningDate>[1],
  ) => ReturnType<typeof enterOpeningDate> | ReturnType<typeof addPartyOpeningBalance>,
): Promise<OpeningActionResult> {
  const allowed = await authorize('opening.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission opening.write (owner)
export async function enterOpeningDateAction(input: unknown): Promise<OpeningActionResult> {
  return guarded((user) => enterOpeningDate(getPool('app'), user, input));
}

// @permission opening.write (owner)
export async function addPartyOpeningBalanceAction(input: unknown): Promise<OpeningActionResult> {
  return guarded((user) => addPartyOpeningBalance(getPool('app'), user, input));
}
