import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { auditDenied } from '../auth/guards';
import { can, type Permission } from '../domain/permissions';
import type { SessionUser } from '../auth/session-gate';
import { ForbiddenError } from './user-admin';

const aiConfirmation = new AsyncLocalStorage<{ proposalId: string }>();
const dryRun = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as the confirmation of an assistant draft: every `inRequest` inside it, in any service, writes its audit events
 * as `ai_confirmed` with the proposal id (SPEC-assistant §7). Used by the confirmation path only, after the proposal was claimed.
 */
export const asAiConfirmation = <T>(proposalId: string, fn: () => Promise<T>): Promise<T> =>
  aiConfirmation.run({ proposalId }, fn);

/**
 * Runs `fn` as a rehearsal: every `inRequest` inside it, in any service, does its work and then rolls back, so a draft's preview
 * is the answer of the very service a confirmation will call, and nothing it did stays (not a row, not a document number, not an
 * audit event). What it returns (a result, never an id of a row that no longer exists) is what the preview shows.
 */
export const asDryRun = <T>(fn: () => Promise<T>): Promise<T> => dryRun.run(true, fn);

/** Runs `fn` in one transaction acting as `actor` (RLS context + audit actor); the only way services reach the database. */
export const inRequest = <T>(pool: pg.Pool, actor: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(
    pool,
    {
      userId: actor.id,
      role: actor.role,
      requestId: uuidv7(realClock.now()),
      aiProposalId: aiConfirmation.getStore()?.proposalId,
      rollback: dryRun.getStore() === true ? true : undefined,
    },
    fn,
  );

/** Layer 2 of SPEC-platform-security §4: the service checks the permission again, whatever the route did. */
export async function require(pool: pg.Pool, actor: SessionUser, permission: Permission): Promise<void> {
  if (can(actor.role, permission)) return;
  await auditDenied(pool, actor, permission);
  throw new ForbiddenError();
}

export const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

/** A malformed id is a NOT_FOUND to the caller, not a server error. */
export const isMalformedId = (error: unknown) => (error as { code?: string }).code === '22P02';

// No parameter property: these files also load under plain node (the CLI scripts), which only strips types.
class RolledBack<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

/**
 * Like `inRequest`, but the transaction never commits: `fn` can write, read what it wrote and return what it saw (the lines of
 * an invoice that was never kept). Used by previews only.
 */
export async function inRequestRolledBack<T>(
  pool: pg.Pool,
  actor: SessionUser,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  try {
    await inRequest(pool, actor, async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as T;
    throw error;
  }
  throw new Error('unreachable');
}
