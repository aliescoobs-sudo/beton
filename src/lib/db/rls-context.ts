import type pg from 'pg';
import { z } from 'zod';

/**
 * Roles known to RLS policies (SPEC-platform-security §4). `system` is the scheduled-job / bootstrap actor;
 * `anonymous` is only for auditing failed logins and is granted nothing.
 */
export const DB_ROLES = ['owner', 'partner', 'office', 'plant', 'support', 'system', 'anonymous'] as const;
/** The V1 accounts (migration 0082): the database maps each to a policy role in `DB_ROLES`, or to none (default deny). */
export const V1_ACTOR_ROLES = [
  'app_admin',
  'office_sales',
  'office_purchases',
  'plant_manager',
  'driver',
  'pump_operator',
  'accountant',
  'client_portal',
  'supplier_portal',
] as const;
export const REQUEST_ROLES = [...DB_ROLES, ...V1_ACTOR_ROLES] as const;

const contextSchema = z.object({
  userId: z.uuid({ error: 'userId must be a UUID' }),
  role: z.enum(REQUEST_ROLES, {
    error: 'role must be a known account role, system or anonymous',
  }),
  requestId: z.string().min(1).max(100),
  simAt: z.date().optional(),
  /** The plant of the request (R1): rows inserted without a plant take it (database trigger `plant_fill`). A context value, not a right. */
  plantId: z.uuid().optional(),
  /** The request passed the step-up (see `SessionUser.stepUpVerified`): the sensitive database doors read it as `app.step_up`. */
  stepUp: z.boolean().optional(),
  /** A draft of the assistant being confirmed by its human: the audit trail then says `ai_confirmed` and names the proposal. */
  aiProposalId: z.uuid().optional(),
  /**
   * R18-05: the phone session this request acts under. When present, the transaction first calls the database fence, which refuses it when the session
   * has ended (a logout, a newer sign-in, a released phone, a changed account) and keeps the device row locked until the transaction ends.
   */
  fieldSession: z
    .object({ driverId: z.uuid(), deviceRowId: z.uuid(), gen: z.number().int(), exp: z.number().int() })
    .optional(),
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
              set_config('app.ai_proposal_id', $5, true), set_config('app.plant_id', $6, true),
              set_config('app.step_up', $7, true)`,
      [
        ctx.userId,
        ctx.role,
        // The proposal id is also in the request id, so one line of the audit log carries both (SPEC-assistant §7).
        ctx.aiProposalId ? `${ctx.requestId}|ai:${ctx.aiProposalId}` : ctx.requestId,
        ctx.simAt?.toISOString() ?? '',
        ctx.aiProposalId ?? '',
        ctx.plantId ?? '',
        ctx.stepUp ? 'verified' : '',
      ],
    );
    if (ctx.fieldSession)
      await client.query('select public.field_session_fence($1, $2, $3, $4)', [
        ctx.fieldSession.driverId,
        ctx.fieldSession.deviceRowId,
        ctx.fieldSession.gen,
        ctx.fieldSession.exp,
      ]);
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
