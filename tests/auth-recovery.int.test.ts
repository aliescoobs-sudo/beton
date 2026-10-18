import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt } from 'better-auth/crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';

// DECISIONS 72: after a recovery-code login, sensitive actions need a real TOTP, and the user must first enrol a new
// authenticator and get a new recovery-code set.
const kit = authTestKit();
afterAll(() => kit.close());
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const nextStep = () => vi.setSystemTime(Date.now() + 30_000);
const state = (cookie: string) => resolveAuthState(kit.auth, new Headers({ cookie }));
const regenerate = (cookie: string) =>
  kit.call('/two-factor/generate-backup-codes', { password: kit.password }, { cookie });

async function recoveryLogin() {
  const user = await kit.enrolledUser();
  nextStep();
  const pending = kit.cookieOf(
    await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
  );
  const res = await kit.call(
    '/two-factor/verify-backup-code',
    { code: user.backupCodes[0] },
    { cookie: pending },
  );
  expect(res.status).toBe(200);
  return { ...user, cookie: kit.cookieOf(res) };
}

describe('after a recovery-code login', () => {
  it('the session is usable but has no second-factor credit and requires re-enrolment', async () => {
    const user = await recoveryLogin();
    const s = await state(user.cookie);
    expect(s.kind).toBe('authenticated');
    if (s.kind !== 'authenticated') return;
    expect(s.session.twoFactorAt).toBeNull();
    expect(s.user.reenrolRequired).toBe(true);
    const [login] = await kit.auditEvents(
      `action = 'login' and actor_user_id = $1 and reason = 'recovery_code'`,
      [user.id],
    );
    expect(login).toBeTruthy();
  });

  it('sensitive actions are refused with REENROL_REQUIRED, even after a TOTP from the old authenticator', async () => {
    const user = await recoveryLogin();
    let res = await regenerate(user.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REENROL_REQUIRED');

    nextStep();
    await kit.call('/two-factor/verify-totp', { code: await kit.totpFor(user.id) }, { cookie: user.cookie });
    res = await regenerate(user.cookie);
    expect((await res.json()).code).toBe('REENROL_REQUIRED');
  });

  it('re-enrolment with a wrong password changes nothing: the current authenticator still works', async () => {
    const user = await recoveryLogin();
    expect(
      (await kit.call('/two-factor/enable', { password: 'wrong-password-123' }, { cookie: user.cookie }))
        .status,
    ).toBe(400);
    nextStep();
    await expect(kit.login(user)).resolves.toBeTruthy();
  });

  it('re-enrolment replaces the authenticator and the recovery codes, then sensitive actions work again', async () => {
    const user = await recoveryLogin();
    const oldSecret = await secretOf(user.id);

    const enable = await kit.call('/two-factor/enable', { password: kit.password }, { cookie: user.cookie });
    expect(enable.status).toBe(200);
    const { backupCodes: fresh } = (await enable.json()) as { backupCodes: string[] };
    expect(fresh).toHaveLength(10);
    const newSecret = await secretOf(user.id);
    expect(newSecret).not.toBe(oldSecret);

    const verify = await kit.call(
      '/two-factor/verify-totp',
      { code: await createOTP(newSecret).totp() },
      { cookie: user.cookie },
    );
    expect(verify.status).toBe(200);
    const s = await state(kit.cookieOf(verify) || user.cookie);
    if (s.kind !== 'authenticated') throw new Error(`expected authenticated, got ${s.kind}`);
    expect(s.user.reenrolRequired).toBe(false);
    expect(s.session.twoFactorAt?.getTime()).toBe(Date.now());
    expect(
      await kit.auditEvents(
        `action = 'two_factor_enrolled' and actor_user_id = $1 and reason = 're_enrolment'`,
        [user.id],
      ),
    ).toHaveLength(1);
    expect((await regenerate(kit.cookieOf(verify) || user.cookie)).status).toBe(200);

    // The old authenticator and the old codes no longer work.
    nextStep();
    const pending = kit.cookieOf(
      await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
    );
    expect(
      (
        await kit.call(
          '/two-factor/verify-totp',
          { code: await createOTP(oldSecret).totp() },
          { cookie: pending },
        )
      ).ok,
    ).toBe(false);
    const pending2 = kit.cookieOf(
      await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
    );
    expect(
      (await kit.call('/two-factor/verify-backup-code', { code: user.backupCodes[1] }, { cookie: pending2 }))
        .ok,
    ).toBe(false);
  });

  it('the new authenticator works at once, even in the same 30 s step as the last code of the old one', async () => {
    const user = await recoveryLogin();
    // A TOTP from the old authenticator claims the current step…
    await kit.call('/two-factor/verify-totp', { code: await kit.totpFor(user.id) }, { cookie: user.cookie });
    // …and re-enrolment in that same step must still accept the new authenticator's code.
    await kit.call('/two-factor/enable', { password: kit.password }, { cookie: user.cookie });
    const verify = await kit.call(
      '/two-factor/verify-totp',
      { code: await createOTP(await secretOf(user.id)).totp() },
      { cookie: user.cookie },
    );
    expect(verify.status).toBe(200);
  });

  it('a user who logged in with TOTP is never asked to re-enrol', async () => {
    const user = await kit.enrolledUser();
    nextStep();
    const { cookie } = await kit.login(user);
    const s = await state(cookie);
    expect(s.kind === 'authenticated' && s.user.reenrolRequired).toBe(false);
    expect((await kit.call('/two-factor/enable', { password: kit.password }, { cookie })).status).toBe(403);
  });
});

describe('enable accepts only the TOTP method', () => {
  it('refuses method "otp", which would enable 2FA without an authenticator', async () => {
    const user = await kit.newUser();
    const cookie = kit.cookieOf(
      await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
    );
    const res = await kit.call('/two-factor/enable', { password: kit.password, method: 'otp' }, { cookie });
    expect(res.status).toBe(400);
    expect((await state(cookie)).kind).toBe('needs_enrolment');
  });
});

async function secretOf(userId: string) {
  const { rows } = await kit.migrator.query(`select secret from "twoFactor" where "userId" = $1`, [userId]);
  return symmetricDecrypt({ key: kit.env.AUTH_SECRET, data: rows[0].secret });
}
