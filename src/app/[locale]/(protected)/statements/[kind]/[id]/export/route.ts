import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  getClientStatement,
  getSupplierStatement,
  parseStatementFilter,
  statementToCsv,
} from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission statements.read (owner, support): the CSV of one statement; every export is audited
export async function GET(
  request: Request,
  { params }: { params: Promise<{ locale: string; kind: string; id: string }> },
): Promise<Response> {
  const { kind, id } = await params;
  const notFound = () => new Response('Not found', { status: 404 });
  if (kind !== 'client' && kind !== 'supplier') return notFound();
  const pool = getPool('app');
  const allowed = await authorize('statements.read', { getState: currentAuthState, appPool: pool });
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
  await recordMoneyExport(pool, allowed.user, `export:statement-${kind}:${result.code}`);
  const csv = statementToCsv(result, result.statement);
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="compte-${result.code}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
