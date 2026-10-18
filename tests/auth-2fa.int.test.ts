import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt } from 'better-auth/crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import { totpQrDataUrl } from '../src/modules/platform-security/domain/totp-qr';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
afterAll(() => kit.close());
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => vi.useRealTimers());

const password = 'correct-horse-battery-staple';
/** Move to the next 30-second TOTP step (a code may be used only once). */
const nextStep = () => vi.setSystemTime(Date.now() + 30_000);

async function newUser() {
  const email = `twofa-${Math.random().toString(36).slice(2)}@belgobeton.test`;
  const { id } = await createUser(kit.auth, kit.authPool, {
    actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
    email,
    name: 'Two Factor',
    password,
    role: 'partner',
    locale: 'ar',
  });
  return { email, id };
}

async function rawSecret(userId: string) {
  const { rows } = await kit.migrator.query(`select secret from "twoFactor" where "userId" = $1`, [userId]);
  return symmetricDecrypt({ key: kit.env.AUTH_SECRET, data: rows[0].secret });
}
const totpFor = async (userId: string) => createOTP(await rawSecret(userId)).totp();
const state = (cookie: string) => resolveAuthState(kit.auth, new Headers({ cookie }));

/** Password login + enrolment (enable + first TOTP). Returns the rotated, fully authenticated cookie. */
async function enrolled() {
  const user = await newUser();
  const first = kit.cookieOf(await kit.call('/sign-in/email', { email: user.email, password }));
  const enable = await kit.call('/two-factor/enable', { password }, { cookie: first });
  const { backupCodes } = (await enable.json()) as { backupCodes: string[] };
  const verify = await kit.call(
    '/two-factor/verify-totp',
    { code: await totpFor(user.id) },
    { cookie: first },
  );
  expect(verify.status).toBe(200);
  nextStep();
  return { ...user, firstCookie: first, cookie: kit.cookieOf(verify), backupCodes };
}

async function passwordStep(email: string) {
  const res = await kit.call('/sign-in/email', { email, password });
  return { body: await res.json(), pending: kit.cookieOf(res) };
}

describe('mandatory enrolment (AC-SEC-01)', () => {
  it('a user without 2FA who logs in with a password is only allowed to enrol', async () => {
    const { email } = await newUser();
    const cookie = kit.cookieOf(await kit.call('/sign-in/email', { email, password }));
    expect((await state(cookie)).kind).toBe('needs_enrolment');
  });

  it('enrolment shows 10 distinct recovery codes once and stores them encrypted, never in clear', async () => {
    const user = await enrolled();
    expect(new Set(user.backupCodes).size).toBe(10);
    const { rows } = await kit.migrator.query(`select "backupCodes" from "twoFactor" where "userId" = $1`, [
      user.id,
    ]);
    expect(rows[0].backupCodes).toMatch(/^f1\./);
    for (const code of user.backupCodes) expect(rows[0].backupCodes).not.toContain(code);
  });

  it('confirming the first code enables 2FA, rotates the session and audits the enrolment', async () => {
    const user = await enrolled();
    expect(await kit.getSession(user.firstCookie)).toBeNull();
    expect((await state(user.cookie)).kind).toBe('authenticated');
    expect(
      await kit.auditEvents(`action = 'two_factor_enrolled' and actor_user_id = $1`, [user.id]),
    ).toHaveLength(1);
    expect(
      await kit.auditEvents(`action = 'recovery_codes_generated' and actor_user_id = $1`, [user.id]),
    ).toHaveLength(1);
  });

  it('enrolling again once 2FA is on is refused (re-enrolment only after an owner reset)', async () => {
    const user = await enrolled();
    expect((await kit.call('/two-factor/enable', { password }, { cookie: user.cookie })).status).toBe(403);
  });

  it('enrolling without a session is refused', async () => {
    expect((await kit.call('/two-factor/enable', { password })).status).toBe(401);
  });
});

describe('enrolment QR code (DECISIONS 73)', () => {
  it('renders for the real enrolment URI of that user, and not for another user', async () => {
    const user = await newUser();
    const cookie = kit.cookieOf(await kit.call('/sign-in/email', { email: user.email, password }));
    const { totpURI } = (await (await kit.call('/two-factor/enable', { password }, { cookie })).json()) as {
      totpURI: string;
    };
    expect(totpQrDataUrl(totpURI, user.email)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(totpQrDataUrl(totpURI, 'someone-else@belgobeton.test')).toBeNull();
  });
});

describe('login with TOTP (AC-SEC-02)', () => {
  it('the password step gives no session; the TOTP step does, records twoFactorAt and audits the login', async () => {
    const user = await enrolled();
    const loginsBefore = (await kit.auditEvents(`action = 'login' and actor_user_id = $1`, [user.id])).length;
    const { body, pending } = await passwordStep(user.email);
    expect(body.twoFactorRedirect).toBe(true);
    expect(await kit.getSession(pending)).toBeNull();

    const res = await kit.call(
      '/two-factor/verify-totp',
      { code: await totpFor(user.id) },
      { cookie: pending },
    );
    expect(res.status).toBe(200);
    const s = await state(kit.cookieOf(res));
    expect(s.kind).toBe('authenticated');
    if (s.kind === 'authenticated') expect(s.session.twoFactorAt?.getTime()).toBe(Date.now());
    // Exactly one login event for password + TOTP (none for the password step alone).
    expect(await kit.auditEvents(`action = 'login' and actor_user_id = $1`, [user.id])).toHaveLength(
      loginsBefore + 1,
    );
  });

  it('a wrong TOTP fails, and 5 wrong codes lock the second factor', async () => {
    const user = await enrolled();
    for (let i = 0; i < 5; i++) {
      const { pending } = await passwordStep(user.email);
      expect((await kit.call('/two-factor/verify-totp', { code: '000000' }, { cookie: pending })).ok).toBe(
        false,
      );
    }
    const { pending } = await passwordStep(user.email);
    const res = await kit.call(
      '/two-factor/verify-totp',
      { code: await totpFor(user.id) },
      { cookie: pending },
    );
    expect(res.status).toBe(429);
  });

  it('refuses a TOTP code that was already used (replay)', async () => {
    const user = await enrolled();
    const code = await totpFor(user.id);
    const a = await passwordStep(user.email);
    expect((await kit.call('/two-factor/verify-totp', { code }, { cookie: a.pending })).status).toBe(200);
    const b = await passwordStep(user.email);
    expect((await kit.call('/two-factor/verify-totp', { code }, { cookie: b.pending })).status).toBe(401);
  });

  it('accepts exactly one of two concurrent uses of the same code', async () => {
    const user = await enrolled();
    const code = await totpFor(user.id);
    const [a, b] = [await passwordStep(user.email), await passwordStep(user.email)];
    const results = await Promise.all([
      kit.call('/two-factor/verify-totp', { code }, { cookie: a.pending }),
      kit.call('/two-factor/verify-totp', { code }, { cookie: b.pending }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('refuses "trust this device", which would skip TOTP for 30 days', async () => {
    const user = await enrolled();
    const { pending } = await passwordStep(user.email);
    const res = await kit.call(
      '/two-factor/verify-totp',
      { code: await totpFor(user.id), trustDevice: true },
      { cookie: pending },
    );
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.includes('trust_device'))).toBe(false);
  });

  it('keeps 2FA management endpoints that would weaken it unreachable', async () => {
    const user = await enrolled();
    for (const path of [
      '/two-factor/disable',
      '/two-factor/get-totp-uri',
      '/two-factor/send-otp',
      '/two-factor/verify-otp',
    ]) {
      expect((await kit.call(path, { password }, { cookie: user.cookie })).status, path).toBe(404);
    }
  });
});

describe('recovery codes (ADR 0001 conditions)', () => {
  it('a recovery code logs in once, is then refused, and every use is audited', async () => {
    const user = await enrolled();
    const code = user.backupCodes[0]!;
    const a = await passwordStep(user.email);
    expect((await kit.call('/two-factor/verify-backup-code', { code }, { cookie: a.pending })).status).toBe(
      200,
    );
    const b = await passwordStep(user.email);
    expect((await kit.call('/two-factor/verify-backup-code', { code }, { cookie: b.pending })).ok).toBe(
      false,
    );
    const events = await kit.auditEvents(`action = 'recovery_code_used' and actor_user_id = $1`, [user.id]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(code);
  });

  it('regenerating returns a new set, invalidates the old one and is audited', async () => {
    const user = await enrolled();
    const res = await kit.call('/two-factor/generate-backup-codes', { password }, { cookie: user.cookie });
    const { backupCodes: fresh } = (await res.json()) as { backupCodes: string[] };
    expect(fresh).toHaveLength(10);

    const old = await passwordStep(user.email);
    expect(
      (
        await kit.call(
          '/two-factor/verify-backup-code',
          { code: user.backupCodes[1] },
          { cookie: old.pending },
        )
      ).ok,
    ).toBe(false);
    const ok = await passwordStep(user.email);
    expect(
      (await kit.call('/two-factor/verify-backup-code', { code: fresh[0] }, { cookie: ok.pending })).status,
    ).toBe(200);
    expect(
      await kit.auditEvents(`action = 'recovery_codes_generated' and actor_user_id = $1`, [user.id]),
    ).toHaveLength(2);
  });

  it('never writes recovery codes or TOTP codes to the logs', async () => {
    const user = await enrolled();
    const { pending } = await passwordStep(user.email);
    await kit.call('/two-factor/verify-backup-code', { code: 'WRONG-CODE1' }, { cookie: pending });
    const logs = kit.logLines.join('\n');
    for (const code of user.backupCodes) expect(logs).not.toContain(code);
  });
});
