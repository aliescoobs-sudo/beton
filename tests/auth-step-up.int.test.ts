import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
afterAll(() => kit.close());
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);
const twoFactorAt = async (cookie: string) => {
  const s = await resolveAuthState(kit.auth, new Headers({ cookie }));
  return s.kind === 'authenticated' ? s.session.twoFactorAt : undefined;
};
const regenerate = (cookie: string) =>
  kit.call('/two-factor/generate-backup-codes', { password: kit.password }, { cookie });

async function loggedIn() {
  const user = await kit.enrolledUser();
  minutes(1);
  return { user, ...(await kit.login(user)) };
}

describe('step-up on a sensitive auth action (AC-SEC-09)', () => {
  it('runs right after login (second factor less than 10 minutes old)', async () => {
    const { cookie } = await loggedIn();
    minutes(9);
    expect((await regenerate(cookie)).status).toBe(200);
  });

  it('is refused with STEP_UP_REQUIRED when the second factor is older than 10 minutes', async () => {
    const { cookie } = await loggedIn();
    minutes(11);
    const res = await regenerate(cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it('a fresh TOTP on the same session refreshes twoFactorAt, is audited, and the action then runs once', async () => {
    const { user, cookie } = await loggedIn();
    minutes(11);
    const before = await twoFactorAt(cookie);
    const step = await kit.call('/two-factor/verify-totp', { code: await kit.totpFor(user.id) }, { cookie });
    expect(step.status).toBe(200);
    const after = await twoFactorAt(cookie);
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    expect(await kit.auditEvents(`action = 'step_up' and actor_user_id = $1`, [user.id])).toHaveLength(1);

    expect((await regenerate(cookie)).status).toBe(200);
    expect(
      await kit.auditEvents(`action = 'recovery_codes_generated' and actor_user_id = $1`, [user.id]),
    ).toHaveLength(2);
  });

  it('a wrong code does not refresh twoFactorAt', async () => {
    const { cookie } = await loggedIn();
    minutes(11);
    const before = await twoFactorAt(cookie);
    expect((await kit.call('/two-factor/verify-totp', { code: '000000' }, { cookie })).ok).toBe(false);
    expect((await twoFactorAt(cookie))!.getTime()).toBe(before!.getTime());
    expect((await regenerate(cookie)).status).toBe(403);
  });

  it('does not affect non-sensitive requests', async () => {
    const { cookie } = await loggedIn();
    minutes(20);
    expect((await kit.getSession(cookie))?.session).toBeTruthy();
  });
});
