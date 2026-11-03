import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from '@/lib/db/pools';

// @permission none (readiness for the reverse proxy and the monitor: the database answers and every migration of this build is
// applied. The answer is a status word only: no build id, no count, no host, no error text.)
let expected: number | undefined;
function expectedMigrations(): number {
  expected ??= (
    JSON.parse(readFileSync(join(process.cwd(), 'db', 'migrations', 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    }
  ).entries.length;
  return expected;
}

export async function GET(): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  try {
    const { rows } = await getPool('app').query<{ n: number }>('select public.applied_migrations() as n');
    // Behind (a migration of this build not run) is not ready. Ahead is fine: migrations are additive, so an older image runs on a
    // newer schema after a rollback (RUNBOOK §6).
    return (rows[0]?.n ?? 0) >= expectedMigrations()
      ? Response.json({ status: 'ready' }, { headers })
      : Response.json({ status: 'not_ready' }, { status: 503, headers });
  } catch {
    return Response.json({ status: 'not_ready' }, { status: 503, headers });
  }
}
