import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { realClock } from '@/modules/clock';
import { needsStepUp, recordAuditEvent, type SessionUser } from '@/modules/platform-security';
import { canFinance, type FinancePermission } from '../domain/permissions';
export type FinanceActor = Omit<SessionUser, 'role'> & { role: string };
export interface FinanceSession {
  user: FinanceActor;
  twoFactorAt: Date | null;
}
export class FinanceUnavailable extends Error {
  constructor() {
    super('FINANCE_UNAVAILABLE');
  }
}
export async function financeRequest<T>(
  pool: pg.Pool,
  actor: FinanceActor,
  permission: FinancePermission,
  fn: (tx: pg.PoolClient) => Promise<T>,
  options?: { session: FinanceSession; configure?: boolean },
) {
  if (!canFinance(actor.role, permission) || !actor.twoFactorEnabled) throw new FinanceUnavailable();
  if (
    options &&
    (options.session.user.id !== actor.id ||
      options.session.user.role !== actor.role ||
      actor.reenrolRequired ||
      needsStepUp(options.session.twoFactorAt, realClock.now()))
  )
    throw new Error('STEP_UP_REQUIRED');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    // Same transaction-local identity contract as platform-security; accepts V1 roles before R2 lands here.
    await tx.query(
      `select set_config('app.user_id',$1,true),set_config('app.role',$2,true),set_config('app.request_id',$3,true),set_config('app.finance_step_up',$4,true)`,
      [actor.id, actor.role, randomUUID(), options ? 'verified' : ''],
    );
    await tx.query(`select set_config('app.sim_at',coalesce(ctx.sim_now()::text,''),true)`);
    if (options) {
      const minutes =
        (await tx.query<{ minutes: number }>('select finance.step_up_minutes() minutes')).rows[0]?.minutes ??
        10;
      if (needsStepUp(options.session.twoFactorAt, realClock.now(), minutes * 60000))
        throw new Error('STEP_UP_REQUIRED');
    }

    if (
      !options?.configure &&
      !(await tx.query<{ enabled: boolean }>('select finance.enabled() enabled')).rows[0]?.enabled
    )
      throw new FinanceUnavailable();
    const result = await fn(tx);
    await recordAuditEvent(tx, {
      action: permission === 'finance.export' ? 'export' : 'view',
      table: permission === 'finance.export' ? 'finance_accounting_export' : 'finance_access',
    });
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
export async function financeEnabled(pool: pg.Pool): Promise<boolean> {
  try {
    return (
      (await pool.query<{ enabled: boolean }>('select finance.enabled() enabled')).rows[0]?.enabled === true
    );
  } catch (error) {
    if (['42883', '3F000'].includes((error as { code?: string }).code ?? '')) return false;
    throw error;
  }
}
