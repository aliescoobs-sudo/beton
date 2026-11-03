import type pg from 'pg';
import { realClock } from '@/modules/clock';
import { auditAuthEvent } from '../auth/audit';
import { auditDenied } from '../auth/guards';
import type { Auth } from '../auth/create-auth';
import type { SessionUser } from '../auth/session-gate';
import { createUser } from '../auth/user-service';
import { can } from '../domain/permissions';
import type { UserLocale } from '../domain/locale';

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface UserAdminDeps {
  auth: Auth;
  /** belgobeton_auth: the only role that can read and change accounts. */
  authPool: pg.Pool;
  /** belgobeton_app: audits permission denials. */
  appPool: pg.Pool;
}

export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: SessionUser['role'];
  locale: UserLocale;
  status: 'active' | 'disabled';
  twoFactorEnabled: boolean;
  provisioned: boolean;
}

export const MANAGED_ROLES = [
  'app_admin',
  'office_sales',
  'office_purchases',
  'plant_manager',
  'driver',
  'pump_operator',
  'accountant',
  'client_portal',
  'supplier_portal',
  'partner',
  'office',
  'plant',
  'support',
] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

/** Service-level guard (SPEC §4, layer 2): only the owner manages users, whatever the UI did. */
async function assertCanManage(deps: UserAdminDeps, actor: SessionUser): Promise<void> {
  if (!can(actor.role, 'users.manage')) {
    await auditDenied(deps.appPool, actor, 'users.manage');
    throw new ForbiddenError();
  }
}

const actorOf = (actor: SessionUser) => ({ userId: actor.id, role: actor.role });

async function revokeSessions(authPool: pg.Pool, userId: string): Promise<void> {
  await authPool.query('delete from session where "userId" = $1', [userId]);
}

/**
 * Removes a user's authenticator, recovery codes and any staged re-enrolment, and ends their sessions: they enrol
 * again at next login. Shared by the owner's reset (T13) and the break-glass CLI (DECISIONS 75).
 */
export async function clearTwoFactor(authPool: pg.Pool, userId: string): Promise<void> {
  await authPool.query('delete from two_factor_pending where user_id = $1', [userId]);
  await authPool.query('delete from "twoFactor" where "userId" = $1', [userId]);
  await authPool.query(
    'update "user" set "twoFactorEnabled" = false, "reenrolRequired" = false, "updatedAt" = $2 where id = $1',
    [userId, realClock.now()],
  );
  await authPool.query('update totp_used_step set last_step = 0 where user_id = $1', [userId]);
  await revokeSessions(authPool, userId);
}

export async function listUsers(deps: UserAdminDeps, actor: SessionUser): Promise<ManagedUser[]> {
  await assertCanManage(deps, actor);
  const { rows } = await deps.authPool.query<ManagedUser>(
    `select id, name, email, role, locale, status, coalesce("twoFactorEnabled", false) as "twoFactorEnabled",
            "provisionedAt" is not null as provisioned
       from "user" order by role = 'owner' desc, name`,
  );
  return rows;
}

export async function createManagedUser(
  deps: UserAdminDeps,
  actor: SessionUser,
  input: {
    email: string;
    name: string;
    role: ManagedRole;
    locale: UserLocale;
    password: string;
    plantId?: string | null;
  },
): Promise<{ id: string }> {
  await assertCanManage(deps, actor);
  if (!MANAGED_ROLES.includes(input.role)) throw new Error('This role cannot be created here');
  // The portals are defined but their flag is off (DECISIONS 123): no account can be made for them yet.
  if (input.role === 'client_portal' || input.role === 'supplier_portal') {
    throw new Error('The portals are switched off');
  }
  // Only the owner makes an app_admin (an app_admin cannot hand out its own level).
  if (input.role === 'app_admin' && actor.role !== 'owner') {
    await auditDenied(deps.appPool, actor, 'users.manage');
    throw new ForbiddenError();
  }
  return createUser(deps.auth, deps.authPool, { ...input, actor: actorOf(actor) });
}

/** Disable (sessions end at once, history kept) or re-enable a user. The owner account cannot be disabled. */
export async function setUserStatus(
  deps: UserAdminDeps,
  actor: SessionUser,
  userId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  await assertCanManage(deps, actor);
  const { rows } = await deps.authPool.query<{ role: string }>('select role from "user" where id = $1', [
    userId,
  ]);
  if (!rows[0]) throw new Error('Unknown user');
  if (rows[0].role === 'owner') throw new Error('The owner account cannot be disabled');
  if (rows[0].role === 'app_admin' && actor.role !== 'owner') throw new ForbiddenError();

  await deps.authPool.query('update "user" set status = $2, "updatedAt" = $3 where id = $1', [
    userId,
    status,
    realClock.now(),
  ]);
  if (status === 'disabled') await revokeSessions(deps.authPool, userId);
  await auditAuthEvent(deps.authPool, actorOf(actor), {
    action: status === 'disabled' ? 'user_disabled' : 'user_enabled',
    table: 'user',
    rowId: userId,
  });
}

/** Removes a user's authenticator and recovery codes; they must enrol again at next login (SPEC §5). */
export async function resetTwoFactor(deps: UserAdminDeps, actor: SessionUser, userId: string): Promise<void> {
  await assertCanManage(deps, actor);
  if (userId === actor.id) throw new Error('You cannot reset your own 2FA');
  // The owner's 2FA is reset by the break-glass CLI only (DECISIONS 75); an app_admin's, by the owner only.
  const target = await deps.authPool.query<{ role: string }>('select role from "user" where id = $1', [
    userId,
  ]);
  if (target.rows[0]?.role === 'owner')
    throw new Error('The owner 2FA is reset by the break-glass command only');
  if (target.rows[0]?.role === 'app_admin' && actor.role !== 'owner') throw new ForbiddenError();

  await clearTwoFactor(deps.authPool, userId);
  await auditAuthEvent(deps.authPool, actorOf(actor), {
    action: 'two_factor_reset',
    table: 'user',
    rowId: userId,
  });
}
