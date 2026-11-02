import { getPool } from '@/lib/db/pools';

// @permission none (readiness for the reverse proxy and the monitor: the database answers and the migrations are applied.
// The answer is a status word only: no build id, no count, no host, no error text.)
export async function GET(): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  try {
    const { rows } = await getPool('app').query<{ ok: boolean }>(
      `select to_regclass('public.plant') is not null and to_regclass('public.audit_event') is not null as ok`,
    );
    return rows[0]?.ok
      ? Response.json({ status: 'ready' }, { headers })
      : Response.json({ status: 'not_ready' }, { status: 503, headers });
  } catch {
    return Response.json({ status: 'not_ready' }, { status: 503, headers });
  }
}
