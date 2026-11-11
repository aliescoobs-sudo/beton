import { APIError, getSessionFromCtx } from 'better-auth/api';
import type pg from 'pg';
import type { Clock } from '@/modules/clock';
import { ANONYMOUS_ACTOR_ID } from './actors';
import { auditAuthEvent } from './audit';

import type { ParameterValues } from '../domain/parameters';

// SPEC §5 (🟡 A8): Better Auth only knows the sliding idle timeout; the absolute cap is ours (ADR 0001 gap 7),
// parameter `auth.session_absolute_hours` (default 12).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookCtx = any;

/**
 * Runs before every auth request: a session older than 12 h is deleted, audited and the request refused,
 * however actively it has been used. resolveAuthState() goes through this too (via getSession).
 */
export async function enforceAbsoluteLifetime(
  ctx: HookCtx,
  deps: { authPool: pg.Pool; clock: Clock; parameters: () => Promise<ParameterValues> },
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  const age = deps.clock.now().getTime() - new Date(session.session.createdAt).getTime();
  if (age <= (await deps.parameters())['auth.session_absolute_hours'] * 3_600_000) return;

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

/**
 * R18-03: a session that belongs to a reserved, unknown or missing role is not a session. Runs before every auth request (also the raw
 * `get-session`, which does not go through the KAYAS gate): the session is deleted (a statement of its own, committed before the refusal),
 * audited, and the request refused.
 */
export async function enforceLoginRole(
  ctx: HookCtx,
  deps: { authPool: pg.Pool },
  isLoginRole: (role: unknown) => boolean,
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  if (isLoginRole((session.user as { role?: unknown }).role)) return;
  await ctx.context.internalAdapter.deleteSession(session.session.token);
  await auditAuthEvent(
    deps.authPool,
    // the actor is the anonymous one: the account's own role is exactly what is not usable (the database refuses it as an actor)
    { userId: ANONYMOUS_ACTOR_ID, role: 'anonymous' },
    {
      action: 'session_revoked',
      table: 'session',
      rowId: session.session.id,
      reason: 'role_not_usable',
      after: { user_id: session.user.id },
    },
  );
  throw new APIError('UNAUTHORIZED', { message: 'Session expired' });
}
