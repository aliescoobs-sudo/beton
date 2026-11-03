import { getPool } from '@/lib/db/pools';
import { canFinance, exportAccountant, financeEnabled } from '@/modules/finance';
import { currentAuthState } from '@/modules/platform-security/next';
// @permission finance.export — accountant receives journals and VAT only, every download audited.
export async function GET(request: Request) {
  const pool = getPool('app'),
    state = await currentAuthState();
  const hidden = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (
    state.kind !== 'authenticated' ||
    !canFinance(state.user.role, 'finance.export') ||
    !(await financeEnabled(pool))
  )
    return hidden();
  const q = new URL(request.url).searchParams,
    from = q.get('from') ?? '',
    to = q.get('to') ?? '';
  try {
    const bytes = await exportAccountant(pool, state.user, from, to);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="journaux-${from}-${to}.xlsx"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('Invalid export', { status: 422, headers: { 'cache-control': 'no-store' } });
  }
}
