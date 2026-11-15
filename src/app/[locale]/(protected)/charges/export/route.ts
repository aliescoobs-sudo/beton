import { getPool } from '@/lib/db/pools';
import { chargesToCsv, listCharges } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission charges.read (owner, app_admin, office_purchases): the CSV of the charges register; every export is audited (D245)
export async function GET(request: Request): Promise<Response> {
  const pool = getPool('app');
  const allowed = await authorize('charges.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return new Response('Not found', { status: 404 });
  const q = new URL(request.url).searchParams;
  const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(q.get(k) ?? '') ? q.get(k) : null);
  const rows = await listCharges(pool, allowed.user, { from: date('from'), to: date('to') });
  await recordMoneyExport(pool, allowed.user, 'export:charges');
  return new Response(chargesToCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="charges.csv"',
      'cache-control': 'no-store',
    },
  });
}
