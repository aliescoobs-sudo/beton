import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getPool } from '@/lib/db/pools';
import { getInvoiceDocument, invoicePdf } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission invoices.read (owner, support): the invoice or credit note as a PDF; every generation is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getPool('app');
  const allowed = await authorize('invoices.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return new Response('Not found', { status: 404 });
  const { id } = await ctx.params;
  const doc = await getInvoiceDocument(pool, allowed.user, id);
  if (!doc) return new Response('Not found', { status: 404 });
  await recordMoneyExport(pool, allowed.user, `export:pdf-invoice:${doc.invoice.number}`);
  return pdfResponse(invoicePdf(doc, await pdfContext(allowed.user)), doc.invoice.number);
}
