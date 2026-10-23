import type pg from 'pg';
import { z } from 'zod';

/**
 * Actions a service may record. Data changes ('insert', 'update') are written only by the
 * capture trigger on each audited table, so a service cannot forge them.
 */
export const SERVICE_AUDIT_ACTIONS = [
  'reverse',
  'archive',
  'login',
  'login_failed',
  'logout',
  'account_locked',
  'permission_denied',
  'export',
  'user_created',
  'user_creation_failed',
  'user_disabled',
  'user_enabled',
  'two_factor_reset',
  'two_factor_enrolled',
  'recovery_codes_generated',
  'recovery_code_used',
  'step_up',
  'session_revoked',
  'ai_proposal',
  'ai_confirmation',
  'telegram_link',
  'clock_advance',
  'view',
] as const;

const eventSchema = z.object({
  action: z.enum(SERVICE_AUDIT_ACTIONS, { error: 'action must be a service-level audit action' }),
  table: z.string().min(1),
  rowId: z.string().optional(),
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
});

export type ServiceAuditEvent = z.infer<typeof eventSchema>;

/** Records a service-level audit event in the caller's transaction (actor comes from withRlsContext). */
export async function recordAuditEvent(tx: pg.PoolClient, event: ServiceAuditEvent): Promise<bigint> {
  const e = eventSchema.parse(event);
  const { rows } = await tx.query<{ id: string }>('select audit.record($1, $2, $3, $4, $5, $6) as id', [
    e.action,
    e.table,
    e.rowId ?? null,
    e.before ?? null,
    e.after ?? null,
    e.reason ?? null,
  ]);
  return BigInt(rows[0]!.id);
}
