import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getPool } from '@/lib/db/pools';
import { avoirPdf, listAvoirs } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission avoirs.read (owner, support): the avoir as a PDF; every generation is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getPool('app');
  const allowed = await authorize('avoirs.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return new Response('Not found', { status: 404 });
  const { id } = await ctx.params;
  const avoir = (await listAvoirs(pool, allowed.user)).find((a) => a.id === id);
  if (!avoir) return new Response('Not found', { status: 404 });
  await recordMoneyExport(pool, allowed.user, `export:pdf-avoir:${avoir.number}`);
  return pdfResponse(avoirPdf(avoir, await pdfContext(allowed.user)), avoir.number);
}
