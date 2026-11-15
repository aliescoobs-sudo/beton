import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * T16 step 0: call ONE door with REAL targets under every context that is not an admitted actor and return the offenders
 * (a context that was not refused with SQLSTATE 42501, or that wrote anything). Same contexts as tests/definer-catalogue.int.test.ts.
 */
export async function noActorOffenders(
  app: pg.Pool,
  sql: string,
  params: unknown[],
  realUsers: { plantManager: string; driver: string },
): Promise<string[]> {
  const contexts: [string, string, string][] = [
    ['unset role, no user', '', ''],
    ['unset role, a real plant manager', '', realUsers.plantManager],
    ['unset role, a real driver', '', realUsers.driver],
    ['unknown role', 'bogus', randomUUID()],
    ['owner claimed by a plant manager', 'owner', realUsers.plantManager],
    ['anonymous', 'anonymous', '00000000-0000-7000-8000-000000000000'],
    ['a role no account has', 'client_portal', randomUUID()],
  ];
  const offenders: string[] = [];
  for (const [label, role, user] of contexts) {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [
        role,
        user,
      ]);
      try {
        await c.query(sql, params);
        offenders.push(`${label}: answered instead of refusing`);
        const w = await c.query<{ x: string | null }>('select pg_current_xact_id_if_assigned()::text as x');
        if (w.rows[0]?.x) offenders.push(`${label}: WROTE`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== '42501') offenders.push(`${label}: refused with ${code}, not 42501`);
      }
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }
  return offenders;
}
