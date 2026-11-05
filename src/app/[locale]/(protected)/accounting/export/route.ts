import { getPool } from '@/lib/db/pools';
import { buildAccountingExport, exportFilesFor, type ExportFile } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const NAMES: Record<ExportFile, string> = {
  sales: 'journal-ventes',
  purchases: 'journal-achats',
  payments: 'reglements',
  ageing: 'balance-agee',
};

// @permission accounting.export (owner, app_admin, support: four files; accountant: the two journals): one CSV of the accountant's files; every download is audited
export async function GET(request: Request): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('accounting.export', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const q = new URL(request.url).searchParams;
  const file = exportFilesFor(allowed.user.role).find((f) => f === q.get('file'));
  if (!file) return notFound();
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  const result = await buildAccountingExport(pool, allowed.user, { from, to });
  if (!result.ok) return new Response(result.error, { status: 422 });
  await recordMoneyExport(pool, allowed.user, `export:accounting-${file}:${from}:${to}`);
  return new Response(result.value.files[file], {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${NAMES[file]}-${from}-${to}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
