import pg from 'pg';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { testEnv } from './db-env';

/** Better Auth wired to the test database, plus helpers that talk to it over HTTP like a browser. */
export function authTestKit() {
  const env = testEnv();
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

  const close = () => Promise.all([authPool.end(), migrator.end()]);

  return { env, auth, authPool, migrator, logLines, call, getSession, cookieOf, auditEvents, close };
}
