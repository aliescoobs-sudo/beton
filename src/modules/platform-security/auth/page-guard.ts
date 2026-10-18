import { notFound, redirect } from 'next/navigation';
import { getPool } from '@/lib/db/pools';
import type { Permission } from '../domain/permissions';
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
