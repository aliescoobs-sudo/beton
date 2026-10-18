import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { superuserUrl } from '../scripts/db-bootstrap';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { resolveAuthState, type SessionUser } from '../src/modules/platform-security/auth/session-gate';
import {
  acknowledgeSecurityAlert,
  pendingSecurityAlerts,
  resetOwnerTwoFactor,
} from '../src/modules/platform-security/service/break-glass';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';

// DECISIONS 75: server-only CLI, database superuser password, audited, alerts owner and partner.
const kit = authTestKit();
const appPool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 2 });
const systemPool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(async () => {
  await Promise.all([appPool.end(), systemPool.end()]);
  await kit.close();
});
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const admin = (password?: string) => {
  const url = new URL(superuserUrl(kit.env, 'postgres'));
  if (password !== undefined) url.password = password;
  return url.toString();
};
const deps = (adminUrl: string) => ({ adminUrl, authPool: kit.authPool, systemPool });

let owner: { id: string; email: string };
let ownerCookie: string;
let partner: SessionUser;
let office: SessionUser;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T07:59:10Z') });
  // This suite needs an owner it can log in as. Suites run one after another on the shared test database: demote any
  // owner created earlier (later suites look the owner up again).
  await kit.migrator.query(`update "user" set role = 'partner' where role = 'owner'`);
  const created = await kit.enrolledUser('owner');
  owner = created;
  ownerCookie = created.cookie;
  partner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'partner');
  office = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'office');
  vi.useRealTimers();
});

describe('user:reset-owner-2fa (break glass)', () => {
  it('refuses a wrong superuser password and leaves the owner untouched', async () => {
    await expect(resetOwnerTwoFactor(deps(admin('wrong-password-123')))).rejects.toThrow(/superuser/i);
    expect((await resolveAuthState(kit.auth, new Headers({ cookie: ownerCookie }))).kind).toBe(
      'authenticated',
    );
  });

  it('refuses credentials that are not a superuser', async () => {
    await expect(resetOwnerTwoFactor(deps(kit.env.DATABASE_URL_MIGRATOR))).rejects.toThrow(/superuser/i);
  });

  it('resets the owner: authenticator and sessions gone, enrolment at next login, audited under the system actor', async () => {
    await resetOwnerTwoFactor(deps(admin()));
    expect((await resolveAuthState(kit.auth, new Headers({ cookie: ownerCookie }))).kind).toBe('anonymous');
    const fresh = kit.cookieOf(
      await kit.call('/sign-in/email', { email: owner.email, password: kit.password }),
    );
    expect((await resolveAuthState(kit.auth, new Headers({ cookie: fresh }))).kind).toBe('needs_enrolment');
    const [event] = await kit.auditEvents(
      `action = 'two_factor_reset' and row_id = $1 and reason = 'break_glass_cli'`,
      [owner.id],
    );
    expect(event).toMatchObject({ actor_user_id: SYSTEM_ACTOR_ID, actor_kind: 'system' });
  });

  it('alerts the owner and the partner until each acknowledges; others never see it', async () => {
    const ownerUser: SessionUser = { ...partner, id: owner.id, role: 'owner', email: owner.email };
    const [alert] = await pendingSecurityAlerts(appPool, ownerUser);
    expect(alert).toMatchObject({ kind: 'owner_2fa_reset' });
    expect(await pendingSecurityAlerts(appPool, partner)).toHaveLength(1);
    expect(await pendingSecurityAlerts(appPool, office)).toEqual([]);

    await acknowledgeSecurityAlert(appPool, partner, alert!.id);
    expect(await pendingSecurityAlerts(appPool, partner)).toEqual([]);
    expect(await pendingSecurityAlerts(appPool, ownerUser)).toHaveLength(1); // the owner still has to acknowledge
    await acknowledgeSecurityAlert(appPool, ownerUser, alert!.id);
    expect(await pendingSecurityAlerts(appPool, ownerUser)).toEqual([]);
  });

  it('an office user cannot acknowledge an alert', async () => {
    await expect(acknowledgeSecurityAlert(appPool, office, '1')).rejects.toThrow();
  });
});
