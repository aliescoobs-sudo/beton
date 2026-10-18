import type pg from 'pg';
import { can, type Permission } from '../domain/permissions';
import { auditAuthEvent } from './audit';
import type { AuthState, SessionUser } from './session-gate';

export type Authorization =
  { ok: true; user: SessionUser } | { ok: false; reason: 'UNAUTHENTICATED' | 'FORBIDDEN' };

export interface GuardDeps {
  getState: () => Promise<AuthState>;
  /** Pool used to audit denials (belgobeton_app). */
  appPool: pg.Pool;
}

/** Records a refused permission check against the authenticated user (SPEC §6). */
export async function auditDenied(
  appPool: pg.Pool,
  user: SessionUser,
  permission: Permission,
): Promise<void> {
  await auditAuthEvent(
    appPool,
    { userId: user.id, role: user.role },
    {
      action: 'permission_denied',
      table: 'permission',
      reason: permission,
    },
  );
}

/**
 * Route and server-action guard (SPEC §4, layer 1): an authenticated, enrolled user whose role holds `permission`.
 * Default deny; every denial is audited.
 */
export async function authorize(
  permission: Permission,
  { getState, appPool }: GuardDeps,
): Promise<Authorization> {
  const state = await getState();
  if (state.kind !== 'authenticated') return { ok: false, reason: 'UNAUTHENTICATED' };
  if (!can(state.user.role, permission)) {
    await auditDenied(appPool, state.user, permission);
    return { ok: false, reason: 'FORBIDDEN' };
  }
  return { ok: true, user: state.user };
}
