import { notFound, redirect } from 'next/navigation';
import { getPool } from '@/lib/db/pools';
import type { Permission } from '../domain/permissions';
import { can } from '../domain/permissions';
import { authorize } from './guards';
import { currentAuthState } from './request-state';
import type { SessionUser } from './session-gate';

/** Page guard: not logged in → login; logged in without the permission → 404 (SPEC §4), audited. */
export async function requirePagePermission(locale: string, permission: Permission): Promise<SessionUser> {
  const result = await authorize(permission, { getState: currentAuthState, appPool: getPool('app') });
  if (result.ok) return result.user;
  if (result.reason === 'UNAUTHENTICATED') redirect(`/${locale}/login`);
  notFound();
}

/**
 * Page guard for a screen that several permissions open (a role-side screen, D245): the role must hold at least one of them.
 * Anything else is the same denial as `requirePagePermission` (audited against the first listed permission, then 404).
 */
export async function requireAnyPagePermission(
  locale: string,
  permissions: readonly [Permission, ...Permission[]],
): Promise<SessionUser> {
  const state = await currentAuthState();
  const held = state.kind === 'authenticated' ? permissions.find((p) => can(state.user.role, p)) : undefined;
  return requirePagePermission(locale, held ?? permissions[0]);
}
