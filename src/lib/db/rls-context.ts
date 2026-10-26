import type pg from 'pg';
import { z } from 'zod';

/**
 * Roles known to RLS policies (SPEC-platform-security §4). `system` is the scheduled-job / bootstrap actor;
 * `anonymous` is only for auditing failed logins and is granted nothing.
 */
export const DB_ROLES = ['owner', 'partner', 'office', 'plant', 'support', 'system', 'anonymous'] as const;

const contextSchema = z.object({
  userId: z.uuid({ error: 'userId must be a UUID' }),
  role: z.enum(DB_ROLES, {
    error: 'role must be one of owner, partner, office, plant, support, system, anonymous',
  }),
  requestId: z.string().min(1).max(100),
  simAt: z.date().optional(),
  /** A draft of the assistant being confirmed by its human: the audit trail then says `ai_confirmed` and names the proposal. */
  aiProposalId: z.uuid().optional(),
  /** Run as usual, then roll everything back: what a draft's preview shows is what the service would do, and none of it stays. */
  rollback: z.boolean().optional(),
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
              set_config('app.request_id', $3, true), set_config('app.sim_at', $4, true),
              set_config('app.ai_proposal_id', $5, true)`,
      [
        ctx.userId,
        ctx.role,
        // The proposal id is also in the request id, so one line of the audit log carries both (SPEC-assistant §7).
        ctx.aiProposalId ? `${ctx.requestId}|ai:${ctx.aiProposalId}` : ctx.requestId,
        ctx.simAt?.toISOString() ?? '',
        ctx.aiProposalId ?? '',
      ],
    );
    // In simulated mode every transaction (including anonymous failed logins) is stamped with the simulated
    // instant, so audit events never depend on the caller remembering to pass it (AC-SEC-08, sim part).
    await client.query(
      `select set_config('app.sim_at', coalesce(nullif(current_setting('app.sim_at', true), ''), ctx.sim_now()::text, ''), true)`,
    );
    const result = await fn(client);
    await client.query(ctx.rollback ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
