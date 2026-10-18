import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorize } from '../src/modules/platform-security/auth/guards';
import { resolveAuthState, type SessionUser } from '../src/modules/platform-security/auth/session-gate';
import {
  createManagedUser,
  ForbiddenError,
  listUsers,
  resetTwoFactor,
  setUserStatus,
} from '../src/modules/platform-security/service/user-admin';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
const appPool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 2 });
afterAll(async () => {
  await appPool.end();
  await kit.close();
});
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const nextStep = () => vi.setSystemTime(Date.now() + 30_000);
const deps = () => ({ auth: kit.auth, authPool: kit.authPool, appPool });
const state = (cookie: string) => resolveAuthState(kit.auth, new Headers({ cookie }));

async function sessionUserOf(cookie: string): Promise<SessionUser> {
  const s = await state(cookie);
  if (s.kind !== 'authenticated') throw new Error(`not authenticated: ${s.kind}`);
  return s.user;
}

let owner: SessionUser;
beforeAll(async () => {
  // The integration database is shared within a run: use the owner if another suite created it.
  const find = () =>
    kit.migrator.query<{ id: string; name: string; email: string; locale: 'fr' | 'ar' }>(
      `select id, name, email, locale from "user" where role = 'owner'`,
    );
  let { rows } = await find();
  if (!rows.length) {
    await kit.newUser('owner');
    ({ rows } = await find());
  }
  const row = rows[0]!;
  owner = { ...row, role: 'owner', twoFactorEnabled: true, reenrolRequired: false };
});

describe('user admin (T13): owner only', () => {
  it('lists users with role, status and whether 2FA is enrolled', async () => {
    const other = await kit.enrolledUser('office');
    const users = await listUsers(deps(), owner);
    expect(users.find((u) => u.id === other.id)).toMatchObject({
      role: 'office',
      status: 'active',
      twoFactorEnabled: true,
    });
    expect(users.find((u) => u.id === owner.id)?.role).toBe('owner');
  });

  it('refuses a non-owner and audits the denial', async () => {
    const partner = await kit.enrolledUser('partner');
    const partnerUser = await sessionUserOf(partner.cookie);
    await expect(listUsers(deps(), partnerUser)).rejects.toBeInstanceOf(ForbiddenError);
    const [event] = await kit.auditEvents(`action = 'permission_denied' and actor_user_id = $1`, [
      partner.id,
    ]);
    expect(event).toMatchObject({ reason: 'users.manage' });
  });

  it('creates partner, office and plant users, never a second owner', async () => {
    const created = await createManagedUser(deps(), owner, {
      email: `new-office-${Date.now()}@belgobeton.test`,
      name: 'New Office',
      role: 'office',
      locale: 'ar',
      password: kit.password,
    });
    const [event] = await kit.auditEvents(`action = 'user_created' and row_id = $1`, [created.id]);
    expect(event.actor_user_id).toBe(owner.id);
    await expect(
      createManagedUser(deps(), owner, {
        email: `owner2-${Date.now()}@belgobeton.test`,
        name: 'Owner 2',
        role: 'owner' as never,
        locale: 'fr',
        password: kit.password,
      }),
    ).rejects.toThrow();
  });
});

describe('disabling a user (AC-SEC-14)', () => {
  it('ends their sessions immediately, blocks login, and keeps their history', async () => {
    const user = await kit.enrolledUser('office');
    nextStep();
    const { cookie } = await kit.login(user);
    const historyBefore = (await kit.auditEvents('actor_user_id = $1', [user.id])).length;

    await setUserStatus(deps(), owner, user.id, 'disabled');

    expect((await state(cookie)).kind).toBe('anonymous');
    expect((await kit.call('/sign-in/email', { email: user.email, password: kit.password })).ok).toBe(false);
    expect((await kit.auditEvents('actor_user_id = $1', [user.id])).length).toBeGreaterThanOrEqual(
      historyBefore,
    );
    expect(await kit.auditEvents(`action = 'user_disabled' and row_id = $1`, [user.id])).toHaveLength(1);

    await setUserStatus(deps(), owner, user.id, 'active');
    nextStep();
    await expect(kit.login(user)).resolves.toBeTruthy();
    expect(await kit.auditEvents(`action = 'user_enabled' and row_id = $1`, [user.id])).toHaveLength(1);
  });

  it('refuses to disable the owner account, including oneself', async () => {
    await expect(setUserStatus(deps(), owner, owner.id, 'disabled')).rejects.toThrow(/owner/i);
  });
});

describe('resetting 2FA', () => {
  it('removes the authenticator, ends the sessions and forces enrolment at next login', async () => {
    const user = await kit.enrolledUser('plant');
    nextStep();
    const { cookie } = await kit.login(user);

    await resetTwoFactor(deps(), owner, user.id);

    expect((await state(cookie)).kind).toBe('anonymous');
    const fresh = kit.cookieOf(
      await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
    );
    expect((await state(fresh)).kind).toBe('needs_enrolment');
    expect(await kit.auditEvents(`action = 'two_factor_reset' and row_id = $1`, [user.id])).toHaveLength(1);
  });

  it('refuses to reset your own 2FA', async () => {
    await expect(resetTwoFactor(deps(), owner, owner.id)).rejects.toThrow(/own/i);
  });
});

describe('authorize (route and action guard)', () => {
  it('lets the owner through for users.manage', async () => {
    const result = await authorize('users.manage', {
      getState: async () => ({
        kind: 'authenticated',
        user: owner,
        session: { id: 's', createdAt: new Date(), twoFactorAt: new Date() },
      }),
      appPool,
    });
    expect(result).toEqual({ ok: true, user: owner });
  });

  it('refuses another role and audits it', async () => {
    const plant = await kit.enrolledUser('plant');
    const plantUser = await sessionUserOf(plant.cookie);
    const result = await authorize('cash.read', {
      getState: async () => ({
        kind: 'authenticated',
        user: plantUser,
        session: { id: 's', createdAt: new Date(), twoFactorAt: null },
      }),
      appPool,
    });
    expect(result).toEqual({ ok: false, reason: 'FORBIDDEN' });
    expect(
      await kit.auditEvents(`action = 'permission_denied' and actor_user_id = $1 and reason = 'cash.read'`, [
        plant.id,
      ]),
    ).toHaveLength(1);
  });

  it('refuses an anonymous request', async () => {
    expect(
      await authorize('orders.read', { getState: async () => ({ kind: 'anonymous' }), appPool }),
    ).toEqual({
      ok: false,
      reason: 'UNAUTHENTICATED',
    });
  });
});
