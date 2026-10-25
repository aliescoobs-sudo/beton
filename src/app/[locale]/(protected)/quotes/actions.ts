'use server';

import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { createQuote, type Effect, type QuoteError } from '@/modules/ledger';
import { authorize, ForbiddenError } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission quotes.write (owner, office): blind entry, the result carries the code and the effects the role may see
export async function createQuoteAction(
  input: unknown,
): Promise<
  | { ok: true; code: string; effects: Effect[] }
  | { ok: false; error: QuoteError | 'UNAUTHENTICATED' | 'FORBIDDEN' }
> {
  const allowed = await authorize('quotes.write', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await createQuote(getPool('app'), allowed.user, input, {
      today: (await getRequestClock()).today(),
    });
    return result.ok ? { ok: true, code: result.value.code, effects: result.value.effects } : result;
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
