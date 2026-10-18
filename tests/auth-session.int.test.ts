import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
afterAll(() => kit.close());
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);
const state = (cookie: string) => resolveAuthState(kit.auth, new Headers({ cookie }));

async function freshSession() {
  const user = await kit.enrolledUser();
  minutes(1); // next TOTP step
  return { user, ...(await kit.login(user)) };
}

describe('session lifetime (AC-SEC-03, real time faked in tests)', () => {
  it('dies after 30 minutes without activity', async () => {
    const { cookie } = await freshSession();
    minutes(29);
    expect((await state(cookie)).kind).toBe('authenticated');
    minutes(31);
    expect((await state(cookie)).kind).toBe('anonymous');
  });

  it('stays alive while used, up to the 12-hour absolute limit, then is revoked and audited', async () => {
    const { user, cookie } = await freshSession();
    for (let elapsed = 25; elapsed <= 700; elapsed += 25) {
      minutes(25);
      expect((await state(cookie)).kind, `after ${elapsed} min`).toBe('authenticated');
    }
    minutes(25); // 12 h 05, still active every 25 min
    expect((await state(cookie)).kind).toBe('anonymous');
    const { rowCount } = await kit.migrator.query(
      `select 1 from session where "userId" = $1 and "createdAt" < now() - interval '1 minute'`,
      [user.id],
    );
    expect(rowCount).toBe(0);
    const [event] = await kit.auditEvents(`action = 'session_revoked' and actor_user_id = $1`, [user.id]);
    expect(event.reason).toBe('absolute_lifetime');
  });

  it('a session past 12 hours cannot use auth endpoints either', async () => {
    const { cookie } = await freshSession();
    for (let i = 0; i < 30; i++) {
      minutes(25);
      await kit.getSession(cookie);
    }
    const res = await kit.call('/two-factor/generate-backup-codes', { password: kit.password }, { cookie });
    expect(res.status).toBe(401);
  });
});

describe('session rotation', () => {
  it('the token after the TOTP step differs from the pending one and from earlier sessions', async () => {
    const user = await kit.enrolledUser();
    minutes(1);
    const first = await kit.login(user);
    minutes(1);
    const second = await kit.login(user);
    const token = (c: string) => c.match(/__Host-bb\.session_token=([^;]+)/)?.[1];
    expect(token(first.cookie)).toBeTruthy();
    expect(token(first.cookie)).not.toBe(token(first.pending));
    expect(token(second.cookie)).not.toBe(token(first.cookie));
  });
});

describe('logout', () => {
  it('deletes the session server-side, so replaying the old cookie is refused, and is audited', async () => {
    const { user, cookie } = await freshSession();
    expect((await kit.call('/sign-out', {}, { cookie })).status).toBe(200);
    expect((await state(cookie)).kind).toBe('anonymous');
    expect(await kit.getSession(cookie)).toBeNull();
    expect(await kit.auditEvents(`action = 'logout' and actor_user_id = $1`, [user.id])).toHaveLength(1);
  });
});
