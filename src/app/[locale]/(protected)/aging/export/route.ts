import { getPool } from '@/lib/db/pools';
import { getRequestClock } from '@/app/request-clock';
import { agingToCsv, getAging } from '@/modules/ledger';
import { authorize, recordMoneyExport } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// @permission aging.client (owner, app_admin, office_sales) or aging.supplier (owner, app_admin, office_purchases): the CSV of one side's aging; every export is audited (D245)
export async function GET(request: Request): Promise<Response> {
  const pool = getPool('app');
  const q = new URL(request.url).searchParams;
  const kind = q.get('kind') === 'supplier' ? 'supplier' : q.get('kind') === 'client' ? 'client' : null;
  if (!kind) return new Response('Not found', { status: 404 });
  const allowed = await authorize(kind === 'client' ? 'aging.client' : 'aging.supplier', {
    getState: currentAuthState,
    appPool: pool,
  });
  if (!allowed.ok) return new Response('Not found', { status: 404 });
  const plant = q.get('plant');
  const report = await getAging(pool, allowed.user, kind, {
    today: (await getRequestClock()).today(),
    plantId: plant && UUID.test(plant) ? plant : null,
  });
  await recordMoneyExport(pool, allowed.user, `export:aging-${kind}`);
  return new Response(agingToCsv(report), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="aging-${kind}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
