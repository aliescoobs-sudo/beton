import type pg from 'pg';
import { realClock } from '@/modules/clock';
import { type AuthActor, auditAuthEvent } from './audit';
import type { Auth } from './create-auth';
import { checkPassword } from './password-policy';

import type { Role } from '../domain/permissions';

export type UserRole = Role;

export interface NewUser {
  actor: AuthActor;
  email: string;
  name: string;
  password: string;
  role: UserRole;
  locale: 'fr' | 'ar';
  /** The plant of a plant_manager (required for that role, forbidden for the others). */
  plantId?: string | null;
}

const PASSWORD_ERRORS = {
  too_short: 'Password must be at least 12 characters',
  too_long: 'Password must be at most 128 characters',
  too_common: 'Password is too common',
} as const;

/**
 * Creates an active user with a password (owner bootstrap CLI, owner's user admin). Audited; never logs the password.
 *
 * Retry-safe (DECISIONS 74): the user row is written disabled and unprovisioned, then the credentials, then it is
 * activated. If a later step fails the user stays disabled, the failure is audited, and calling again with the same
 * email resumes the unfinished user instead of creating a second one.
 */
export async function createUser(auth: Auth, authPool: pg.Pool, input: NewUser): Promise<{ id: string }> {
  const check = checkPassword(input.password);
  if (!check.ok) throw new Error(PASSWORD_ERRORS[check.reason]);
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();

  const { rows: existing } = await authPool.query<{ id: string; provisioned: boolean }>(
    `select id, "provisionedAt" is not null as provisioned from "user" where email = $1`,
    [email],
  );
  if (existing[0]?.provisioned) throw new Error('A user with this email already exists');

  if ((input.role === 'plant_manager') !== Boolean(input.plantId)) {
    throw new Error('A plant manager needs a plant, and nobody else has one');
  }
  if (input.role === 'owner') {
    const { rowCount } = await authPool.query(`select 1 from "user" where role = 'owner' and email <> $1`, [
      email,
    ]);
    if (rowCount) throw new Error('An owner already exists');
  }

  const ctx = await auth.$context;
  let userId = existing[0]?.id;
  if (userId) {
    // Resuming an unfinished creation: align it with this request.
    await authPool.query(
      'update "user" set name = $2, role = $3, locale = $4, "plantId" = $6, "updatedAt" = $5 where id = $1',
      [userId, name, input.role, input.locale, realClock.now(), input.plantId ?? null],
    );
  } else {
    const user = await ctx.internalAdapter.createUser(
      { email, name, emailVerified: true, role: input.role, locale: input.locale, status: 'disabled' },
      { method: 'email-password' },
    );
    userId = user.id;
    if (input.plantId) {
      await authPool.query('update "user" set "plantId" = $2 where id = $1', [userId, input.plantId]);
    }
  }

  try {
    const { rowCount: hasCredential } = await authPool.query(
      `select 1 from account where "userId" = $1 and "providerId" = 'credential'`,
      [userId],
    );
    if (!hasCredential) {
      await ctx.internalAdapter.linkAccount({
        userId,
        providerId: 'credential',
        accountId: userId,
        password: await ctx.password.hash(input.password),
      });
    }
    await authPool.query(
      `update "user" set status = 'active', "provisionedAt" = $2, "updatedAt" = $2, "createdBy" = $3 where id = $1`,
      [userId, realClock.now(), input.actor.userId],
    );
  } catch {
    // The error text may carry driver details; the audit only records that the credentials were not written.
    await auditAuthEvent(authPool, input.actor, {
      action: 'user_creation_failed',
      table: 'user',
      rowId: userId,
      reason: 'credentials_not_written',
    });
    throw new Error('User creation did not complete; the user stays disabled. Retry to complete it.');
  }

  await auditAuthEvent(authPool, input.actor, {
    action: 'user_created',
    table: 'user',
    rowId: userId,
    after: { role: input.role, locale: input.locale },
  });
  return { id: userId };
}
