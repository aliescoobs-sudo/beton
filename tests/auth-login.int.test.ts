import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { keyedHash } from '../src/lib/crypto/hmac';
import { ANONYMOUS_ACTOR_ID, BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { authTestKit } from './auth-helpers';

const kit = authTestKit();
const noProxyKit = authTestKit({ TRUSTED_PROXY_HOPS: 0 });
afterAll(() => Promise.all([kit.close(), noProxyKit.close()]));
afterEach(() => vi.useRealTimers());

const password = 'correct-horse-battery-staple';
let n = 0;
/** A fresh office user per test, so lockout counters never interfere. */
async function freshUser() {
  n += 1;
  const email = `office${n}-${Date.now()}@kayas.test`;
  const user = await createUser(kit.auth, kit.authPool, {
    actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
    email,
    name: `Office ${n}`,
    password,
    role: 'office',
    locale: 'fr',
  });
  return { email, id: user.id };
}

describe('password login (T9, AC-SEC-02 password part)', () => {
  beforeAll(async () => {
    // An owner exists for the single-owner tests below (another suite may already have created it).
    const { rowCount } = await kit.migrator.query(`select 1 from "user" where role = 'owner'`);
    if (rowCount) return;
    await createUser(kit.auth, kit.authPool, {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
      email: 'owner@kayas.test',
      name: 'Owner',
      password,
      role: 'owner',
      locale: 'fr',
    });
  });

  it('logs in with the right password and records a login audit event for that user', async () => {
    const { email, id } = await freshUser();
    const res = await kit.call('/sign-in/email', { email, password });
    expect(res.status).toBe(200);
    expect(await kit.auditEvents(`action = 'login' and actor_user_id = $1`, [id])).toHaveLength(1);
  });

  it('gives the same status and message for an unknown email and a wrong password', async () => {
    const { email } = await freshUser();
    const unknown = await kit.call('/sign-in/email', {
      email: `nobody-${Date.now()}@kayas.test`,
      password,
    });
    const wrong = await kit.call('/sign-in/email', { email, password: 'wrong-password-123' });
    expect(unknown.status).toBe(wrong.status);
    expect((await unknown.json()).message).toBe((await wrong.json()).message);
  });

  it('locks an account after 5 failures for 15 minutes, with the same message whether or not it exists', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const { email } = await freshUser();
    for (let i = 0; i < 5; i++)
      await kit.call('/sign-in/email', { email, password: `wrong-password-${i}xx` });

    const locked = await kit.call('/sign-in/email', { email, password });
    expect(locked.status).toBe(429);

    const ghost = `ghost-${Date.now()}@kayas.test`;
    for (let i = 0; i < 5; i++)
      await kit.call('/sign-in/email', { email: ghost, password: `wrong-password-${i}xx` });
    const ghostLocked = await kit.call('/sign-in/email', { email: ghost, password });
    expect(ghostLocked.status).toBe(429);
    expect((await ghostLocked.json()).message).toBe((await locked.json()).message);

    vi.setSystemTime(Date.now() + 14 * 60 * 1000);
    expect((await kit.call('/sign-in/email', { email, password })).status).toBe(429);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect((await kit.call('/sign-in/email', { email, password })).status).toBe(200);
  });

  it('does not count attempts made while locked (the lock does not extend forever)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const { email } = await freshUser();
    for (let i = 0; i < 5; i++)
      await kit.call('/sign-in/email', { email, password: `wrong-password-${i}xx` });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    for (let i = 0; i < 5; i++) await kit.call('/sign-in/email', { email, password: `wrong-again-${i}xxxx` });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect((await kit.call('/sign-in/email', { email, password })).status).toBe(200);
  });

  it('a success resets the failure count', async () => {
    const { email } = await freshUser();
    for (let i = 0; i < 4; i++)
      await kit.call('/sign-in/email', { email, password: `wrong-password-${i}xx` });
    expect((await kit.call('/sign-in/email', { email, password })).status).toBe(200);
    for (let i = 0; i < 4; i++)
      await kit.call('/sign-in/email', { email, password: `wrong-password-${i}yy` });
    expect((await kit.call('/sign-in/email', { email, password })).status).toBe(200);
  });

  it('blocks an IP after 20 failures in 15 minutes, across accounts', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 20; i++) {
      await kit.call('/sign-in/email', { email: `spray${i}-${Date.now()}@kayas.test`, password }, { ip });
    }
    const { email } = await freshUser();
    expect((await kit.call('/sign-in/email', { email, password }, { ip })).status).toBe(429);
    expect((await kit.call('/sign-in/email', { email, password }, { ip: '203.0.113.78' })).status).toBe(200);
  });

  it('counts the IP the trusted proxy appended, so a spoofed first hop does not evade or move the lockout', async () => {
    const real = '203.0.113.90';
    for (let i = 0; i < 20; i++) {
      await kit.call(
        '/sign-in/email',
        { email: `spoof${i}-${Date.now()}@kayas.test`, password },
        { ip: `198.51.100.${i + 1}, ${real}` },
      );
    }
    const { email } = await freshUser();
    expect((await kit.call('/sign-in/email', { email, password }, { ip: `10.9.9.9, ${real}` })).status).toBe(
      429,
    );
    expect((await kit.call('/sign-in/email', { email, password }, { ip: `${real}, 10.9.9.9` })).status).toBe(
      200,
    );
  });

  it('ignores X-Forwarded-For without a trusted proxy: no per-IP lockout', async () => {
    const ip = '203.0.113.91';
    for (let i = 0; i < 21; i++) {
      await noProxyKit.call(
        '/sign-in/email',
        { email: `noproxy${i}-${Date.now()}@kayas.test`, password },
        { ip },
      );
    }
    const { email } = await freshUser();
    expect((await noProxyKit.call('/sign-in/email', { email, password }, { ip })).status).toBe(200);
  });

  it('audits a failed login for an unknown email with the anonymous actor and only a keyed hash of the identifier', async () => {
    const ghost = `unknown-${Date.now()}@kayas.test`;
    await kit.call('/sign-in/email', { email: ghost, password: 'some-password-xyz' });
    const hmac = keyedHash(kit.env.LOOKUP_HMAC_KEY, ghost).toString('hex');
    const [event] = await kit.auditEvents(`action = 'login_failed' and after->>'identifier_hmac' = $1`, [
      hmac,
    ]);
    expect(event).toMatchObject({ actor_user_id: ANONYMOUS_ACTOR_ID, actor_kind: 'anonymous', row_id: null });
    expect(JSON.stringify(event)).not.toContain(ghost);
    expect(JSON.stringify(event)).not.toContain('some-password-xyz');
  });

  it('audits a failed login for a known account against that account, still with the anonymous actor', async () => {
    const { email, id } = await freshUser();
    await kit.call('/sign-in/email', { email, password: 'wrong-password-999' });
    const [event] = await kit.auditEvents(`action = 'login_failed' and row_id = $1`, [id]);
    expect(event).toMatchObject({ actor_user_id: ANONYMOUS_ACTOR_ID, actor_kind: 'anonymous' });
    expect(JSON.stringify(event)).not.toContain(email);
  });

  it('stores login attempts as keyed hashes only', async () => {
    const { rows } = await kit.migrator.query(
      `select count(*)::int as n from login_attempt where identifier_hmac::text like '%@%' or ip_hmac::text like '%.%'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('never writes attempted passwords or identifiers to the logs', async () => {
    const ghost = `logscan-${Date.now()}@kayas.test`;
    const attempted = 'attempted-secret-password-42';
    await kit.call('/sign-in/email', { email: ghost, password: attempted });
    await kit.call('/sign-in/email', { email: 'not-an-email', password: attempted });
    const logs = kit.logLines.join('\n');
    expect(logs).not.toContain(attempted);
    expect(logs).not.toContain(ghost);
  });

  it('prints nothing from the auth library outside our redacting logger', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m));
    const stderr = vi.spyOn(process.stderr, 'write');
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      await kit.call('/sign-in/email', {
        email: `quiet-${Date.now()}@kayas.test`,
        password: 'nope-nope-nope-1',
      });
      await kit.call('/sign-up/email', {});
      for (const spy of [...spies, stderr, stdout]) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of [...spies, stderr, stdout]) spy.mockRestore();
    }
  });

  it('refuses every auth endpoint that is not explicitly allowed', async () => {
    for (const path of [
      '/sign-up/email',
      '/update-user',
      '/delete-user',
      '/change-email',
      '/list-sessions',
    ]) {
      const res = await kit.call(path, {});
      expect(res.status, path).toBe(404);
    }
  });
});

describe('createUser (owner bootstrap and user admin)', () => {
  const bootstrap = { userId: BOOTSTRAP_ACTOR_ID, role: 'system' as const };

  it('if writing the credentials fails, the user stays disabled, the failure is audited, and a retry completes it', async () => {
    const email = `retry-${Date.now()}@kayas.test`;
    const input = {
      actor: bootstrap,
      email,
      name: 'Retry',
      password,
      role: 'office' as const,
      locale: 'fr' as const,
    };
    const ctx = await kit.auth.$context;
    const spy = vi
      .spyOn(ctx.internalAdapter, 'linkAccount')
      .mockRejectedValueOnce(new Error('connection lost'));
    try {
      await expect(createUser(kit.auth, kit.authPool, input)).rejects.toThrow(/retry/i);
    } finally {
      spy.mockRestore();
    }

    const { rows } = await kit.migrator.query(
      `select id, status, "provisionedAt" from "user" where email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'disabled', provisionedAt: null });
    const [failure] = await kit.auditEvents(`action = 'user_creation_failed' and row_id = $1`, [rows[0].id]);
    expect(failure).toMatchObject({ actor_user_id: BOOTSTRAP_ACTOR_ID, reason: 'credentials_not_written' });
    expect(JSON.stringify(failure)).not.toContain('connection lost');
    expect((await kit.call('/sign-in/email', { email, password })).ok).toBe(false);

    const retried = await createUser(kit.auth, kit.authPool, input);
    expect(retried.id).toBe(rows[0].id);
    const { rows: after } = await kit.migrator.query(
      `select status, "provisionedAt" from "user" where email = $1`,
      [email],
    );
    expect(after[0].status).toBe('active');
    expect(after[0].provisionedAt).toBeInstanceOf(Date);
    expect((await kit.call('/sign-in/email', { email, password })).status).toBe(200);
    expect(await kit.auditEvents(`action = 'user_created' and row_id = $1`, [retried.id])).toHaveLength(1);
  });

  it('refuses to create a user whose email already belongs to a completed account', async () => {
    const email = `dup-${Date.now()}@kayas.test`;
    const input = {
      actor: bootstrap,
      email,
      name: 'Dup',
      password,
      role: 'office' as const,
      locale: 'fr' as const,
    };
    await createUser(kit.auth, kit.authPool, input);
    await expect(createUser(kit.auth, kit.authPool, input)).rejects.toThrow(/already exists/);
  });

  it('refuses a second owner', async () => {
    await expect(
      createUser(kit.auth, kit.authPool, {
        actor: bootstrap,
        email: `owner2-${Date.now()}@kayas.test`,
        name: 'Owner 2',
        password,
        role: 'owner',
        locale: 'fr',
      }),
    ).rejects.toThrow(/owner already exists/);
  });

  it.each([
    ['short-pass1', /12/],
    ['Unbelievable', /common/],
  ])('refuses the weak password %s', async (weak, message) => {
    await expect(
      createUser(kit.auth, kit.authPool, {
        actor: bootstrap,
        email: `weak-${Date.now()}@kayas.test`,
        name: 'Weak',
        password: weak,
        role: 'office',
        locale: 'fr',
      }),
    ).rejects.toThrow(message);
  });

  it('stores an argon2id hash and a lowercase email, and audits the creation without the password', async () => {
    const email = `Mixed.Case-${Date.now()}@kayas.test`;
    const user = await createUser(kit.auth, kit.authPool, {
      actor: bootstrap,
      email,
      name: 'Mixed',
      password,
      role: 'plant',
      locale: 'ar',
    });
    const { rows } = await kit.migrator.query(
      `select u.email, a.password from "user" u join account a on a."userId" = u.id where u.id = $1`,
      [user.id],
    );
    expect(rows[0].email).toBe(email.toLowerCase());
    expect(rows[0].password).toMatch(/^\$argon2id\$/);
    const [event] = await kit.auditEvents(`action = 'user_created' and row_id = $1`, [user.id]);
    expect(event).toMatchObject({ actor_user_id: BOOTSTRAP_ACTOR_ID, actor_kind: 'system' });
    expect(event.after).toEqual({ role: 'plant', locale: 'ar' });
  });
});
