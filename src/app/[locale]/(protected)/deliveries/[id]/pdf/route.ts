import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getPool } from '@/lib/db/pools';
import { legalMentions } from '@/modules/ledger';
import { deliveryNotePdf, getDeliveryNote } from '@/modules/operations';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission deliveries.read (every signed-in role): the BL as a PDF, without any price; every generation is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getPool('app');
  const allowed = await authorize('deliveries.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return new Response('Not found', { status: 404 });
  const { id } = await ctx.params;
  const note = await getDeliveryNote(pool, allowed.user, id);
  if (!note) return new Response('Not found', { status: 404 });
  const { company, specimen } = await pdfContext(allowed.user);
  // the BL carries the registrations but never the bank account
  const mentions = company ? legalMentions({ ...company, rib: null }) : [];
  await recordMoneyExport(pool, allowed.user, `export:pdf-bl:${note.blNo}`);
  return pdfResponse(deliveryNotePdf(note, { specimen, company: mentions }), `BL-${note.blNo}`);
}
