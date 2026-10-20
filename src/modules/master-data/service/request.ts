import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import {
  auditDenied,
  can,
  ForbiddenError,
  type Permission,
  type SessionUser,
} from '@/modules/platform-security';

export const inRequest = <T>(pool: pg.Pool, actor: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(pool, { userId: actor.id, role: actor.role, requestId: uuidv7(realClock.now()) }, fn);

/** Layer 2 of SPEC-platform-security §4: the service checks the permission again, whatever the route did. */
export async function require(pool: pg.Pool, actor: SessionUser, permission: Permission): Promise<void> {
  if (can(actor.role, permission)) return;
  await auditDenied(pool, actor, permission);
  throw new ForbiddenError();
}

export const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

/** A malformed id is a NOT_FOUND to the caller, not a server error. */
export const isMalformedId = (error: unknown) => (error as { code?: string }).code === '22P02';
