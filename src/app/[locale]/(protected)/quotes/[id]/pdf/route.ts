import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getPool } from '@/lib/db/pools';
import { getQuote, quotePdf } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission quotes.read (owner, support): the quote as a PDF; every generation is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getPool('app');
  const allowed = await authorize('quotes.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return new Response('Not found', { status: 404 });
  const { id } = await ctx.params;
  const quote = await getQuote(pool, allowed.user, id);
  if (!quote) return new Response('Not found', { status: 404 });
  await recordMoneyExport(pool, allowed.user, `export:pdf-quote:${quote.code}`);
  return pdfResponse(quotePdf(quote, await pdfContext(allowed.user)), quote.code);
}
