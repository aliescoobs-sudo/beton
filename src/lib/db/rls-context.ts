import type pg from 'pg';
import { z } from 'zod';

/** Roles known to RLS policies (SPEC-platform-security §4); `system` is the scheduled-job actor. */
export const DB_ROLES = ['owner', 'partner', 'office', 'plant', 'system'] as const;

const contextSchema = z.object({
  userId: z.uuid({ error: 'userId must be a UUID' }),
  role: z.enum(DB_ROLES, { error: 'role must be one of owner, partner, office, plant, system' }),
  requestId: z.string().min(1).max(100),
  simAt: z.date().optional(),
});

export type RlsContext = z.infer<typeof contextSchema>;

/**
 * Runs `fn` in one transaction whose settings identify the actor for RLS policies and the audit trigger.
 * Settings are transaction-local (`set_config(..., true)`), so they vanish at COMMIT/ROLLBACK and never
 * leak to the next user of a pooled connection. This is the only way services should reach the database.
 */
export async function withRlsContext<T>(
  pool: pg.Pool,
  context: RlsContext,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const ctx = contextSchema.parse(context);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `select set_config('app.user_id', $1, true), set_config('app.role', $2, true),
              set_config('app.request_id', $3, true), set_config('app.sim_at', $4, true)`,
      [ctx.userId, ctx.role, ctx.requestId, ctx.simAt?.toISOString() ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
