'use server';

import { getPool } from '@/lib/db/pools';
import { getQuote } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission quotes.read (owner, support): the print of a quote is audited as an export (DECISIONS 82)
export async function printQuoteAction(quoteId: string): Promise<{ ok: boolean }> {
  const allowed = await authorize('quotes.read', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false };
  const quote = await getQuote(getPool('app'), allowed.user, quoteId);
  if (!quote) return { ok: false };
  await recordMoneyExport(getPool('app'), allowed.user, `print:quote:${quote.code}`);
  return { ok: true };
}
