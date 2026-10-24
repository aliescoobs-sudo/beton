'use server';

import { getPool } from '@/lib/db/pools';
import { createMoneyAccount, type MoneyAccountError, setOpeningBalance } from '@/modules/ledger';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

export type AccountActionResult =
  { ok: true } | { ok: false; error: MoneyAccountError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

async function guarded(
  run: (user: Parameters<typeof createMoneyAccount>[1]) => ReturnType<typeof createMoneyAccount>,
): Promise<AccountActionResult> {
  const allowed = await authorize('money_accounts.write', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await run(allowed.user);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission money_accounts.write (owner)
export async function createMoneyAccountAction(input: unknown): Promise<AccountActionResult> {
  return guarded((user) => createMoneyAccount(getPool('app'), user, input));
}

// @permission money_accounts.write (owner)
export async function setOpeningBalanceAction(input: unknown): Promise<AccountActionResult> {
  return guarded((user) => setOpeningBalance(getPool('app'), user, input));
}
