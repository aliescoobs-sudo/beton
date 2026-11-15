import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  getClientStatement,
  getSupplierStatement,
  parseStatementFilter,
  statementPdf,
} from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission statements.client | statements.supplier (owner, support; office_sales the client side, office_purchases the supplier side, D245): the statement of one client or supplier as a PDF; every generation is audited
export async function GET(
  request: Request,
  { params }: { params: Promise<{ locale: string; kind: string; id: string }> },
): Promise<Response> {
  const { kind, id } = await params;
  const notFound = () => new Response('Not found', { status: 404 });
  if (kind !== 'client' && kind !== 'supplier') return notFound();
  const pool = getPool('app');
  const allowed = await authorize(kind === 'client' ? 'statements.client' : 'statements.supplier', {
    getState: currentAuthState,
    appPool: pool,
  });
  if (!allowed.ok) return notFound();
  const q = new URL(request.url).searchParams;
  const filter = parseStatementFilter({
    from: q.get('from') ?? '',
    to: q.get('to') ?? '',
    type: q.get('type') ?? '',
    status: q.get('status') ?? '',
  });
  const today = (await getRequestClock()).today();
  const result = await (kind === 'client' ? getClientStatement : getSupplierStatement)(
    pool,
    allowed.user,
    id,
    filter,
    { today },
  );
  if (!result) return notFound();
  await recordMoneyExport(pool, allowed.user, `export:pdf-statement-${kind}:${result.code}`);
  const bytes = statementPdf(kind, result, result.statement, today, await pdfContext(allowed.user));
  return pdfResponse(bytes, `releve-${result.code}`);
}
