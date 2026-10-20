import { createOTP } from '@better-auth/utils/otp';
import pg from 'pg';
import type { Env } from '../src/lib/env';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createUser, type UserRole } from '../src/modules/platform-security/auth/user-service';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { testEnv } from './db-env';

/** Better Auth wired to the test database, plus helpers that talk to it over HTTP like a browser. */
export function authTestKit(overrides: Partial<Env> = {}) {
  // One trusted reverse proxy by default: X-Forwarded-For is honoured only for the hop it appends.
  const env = { ...testEnv(), TRUSTED_PROXY_HOPS: 1, ...overrides };
  const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 4 });
  const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
  const logLines: string[] = [];
  const auth = createAuth({ authPool, env, log: (line) => logLines.push(line) });
  const base = env.APP_BASE_URL;

  async function call(path: string, body: unknown, opts: { cookie?: string; ip?: string } = {}) {
    return auth.handler(
      new Request(`${base}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function getSession(cookie: string) {
    const res = await auth.handler(
      new Request(`${base}/api/auth/get-session`, { headers: { cookie, origin: base } }),
    );
    return res.json();
  }

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .filter((c) => c !== '' && !c.endsWith('='))
      .join('; ');

  async function auditEvents(where: string, params: unknown[] = []) {
    const { rows } = await migrator.query(
      `select action, actor_user_id, actor_kind, row_id, after, reason from audit_event where ${where} order by id`,
      params,
    );
    return rows;
  }

  const password = 'correct-horse-battery-staple';

  async function newUser(role: UserRole = 'partner') {
    const email = `user-${Math.random().toString(36).slice(2)}@belgobeton.test`;
    const { id } = await createUser(auth, authPool, {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
      email,
      name: 'Test User',
      password,
      role,
      locale: 'fr',
    });
    return { email, id };
  }

  async function totpFor(userId: string) {
    const { rows } = await migrator.query(`select secret from "twoFactor" where "userId" = $1`, [userId]);
    return createOTP(await authSecretCipher(env).decrypt(rows[0].secret)).totp();
  }

  /** Password login + 2FA enrolment. Callers using fake timers should move to the next 30 s step before the next code. */
  async function enrolledUser(role: UserRole = 'partner') {
    const user = await newUser(role);
    const first = cookieOf(await call('/sign-in/email', { email: user.email, password }));
    const enable = await call('/two-factor/enable', { password }, { cookie: first });
    const { backupCodes } = (await enable.json()) as { backupCodes: string[] };
    const verify = await call('/two-factor/verify-totp', { code: await totpFor(user.id) }, { cookie: first });
    if (verify.status !== 200) throw new Error(`enrolment failed: ${verify.status}`);
    return { ...user, firstCookie: first, cookie: cookieOf(verify), backupCodes };
  }

  /** Full login (password + TOTP) of an enrolled user; returns the session cookie. */
  async function login(user: { email: string; id: string }) {
    const pending = cookieOf(await call('/sign-in/email', { email: user.email, password }));
    const res = await call('/two-factor/verify-totp', { code: await totpFor(user.id) }, { cookie: pending });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    return { pending, cookie: cookieOf(res) };
  }

  const close = () => Promise.all([authPool.end(), migrator.end()]);

  return {
    env,
    auth,
    authPool,
    migrator,
    logLines,
    password,
    call,
    getSession,
    cookieOf,
    auditEvents,
    newUser,
    totpFor,
    enrolledUser,
    login,
    close,
  };
}
