import type pg from 'pg';
import { type AuthActor, auditAuthEvent } from './audit';
import type { Auth } from './create-auth';
import { checkPassword } from './password-policy';

export type UserRole = 'owner' | 'partner' | 'office' | 'plant';

export interface NewUser {
  actor: AuthActor;
  email: string;
  name: string;
  password: string;
  role: UserRole;
  locale: 'fr' | 'ar';
}

const PASSWORD_ERRORS = {
  too_short: 'Password must be at least 12 characters',
  too_long: 'Password must be at most 128 characters',
  too_common: 'Password is too common',
} as const;

/** Creates an active user with a password (owner bootstrap CLI, owner's user admin). Audited, never logs the password. */
export async function createUser(auth: Auth, authPool: pg.Pool, input: NewUser): Promise<{ id: string }> {
  const check = checkPassword(input.password);
  if (!check.ok) throw new Error(PASSWORD_ERRORS[check.reason]);

  if (input.role === 'owner') {
    const { rowCount } = await authPool.query(`select 1 from "user" where role = 'owner'`);
    if (rowCount) throw new Error('An owner already exists');
  }

  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      emailVerified: true,
      role: input.role,
      locale: input.locale,
      status: 'active',
    },
    { method: 'email-password' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(input.password),
  });

  await auditAuthEvent(authPool, input.actor, {
    action: 'user_created',
    table: 'user',
    rowId: user.id,
    after: { role: input.role, locale: input.locale },
  });
  return { id: user.id };
}
