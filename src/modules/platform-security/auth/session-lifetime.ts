import { APIError, getSessionFromCtx } from 'better-auth/api';
import type pg from 'pg';
import type { Clock } from '@/modules/clock';
import { auditAuthEvent } from './audit';

// SPEC §5 (🟡 A8): Better Auth only knows the sliding idle timeout; the absolute cap is ours (ADR 0001 gap 7).
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookCtx = any;

/**
 * Runs before every auth request: a session older than 12 h is deleted, audited and the request refused,
 * however actively it has been used. resolveAuthState() goes through this too (via getSession).
 */
export async function enforceAbsoluteLifetime(
  ctx: HookCtx,
  deps: { authPool: pg.Pool; clock: Clock },
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  const age = deps.clock.now().getTime() - new Date(session.session.createdAt).getTime();
  if (age <= SESSION_ABSOLUTE_MS) return;

  await ctx.context.internalAdapter.deleteSession(session.session.token);
  await auditAuthEvent(
    deps.authPool,
    { userId: session.user.id, role: session.user.role },
    {
      action: 'session_revoked',
      table: 'session',
      rowId: session.session.id,
      reason: 'absolute_lifetime',
    },
  );
  throw new APIError('UNAUTHORIZED', { message: 'Session expired' });
}
