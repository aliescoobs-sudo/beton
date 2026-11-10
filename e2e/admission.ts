import { E2E_DATABASE } from '../scripts/db-bootstrap';

/**
 * R17 (T10d): the e2e setup RECREATES a database and creates accounts (some of them with roles the application refuses in production). It runs
 * only against the e2e target: NODE_ENV is not production, APP_ENV is not production, the database it will recreate is the e2e one, and every
 * connection string it was given points at a loopback host. Anything else throws before a single statement runs.
 */
export function assertE2eTarget(env: Record<string, string | undefined>, urls: string[]): void {
  const fail = (why: string): never => {
    throw new Error(`e2e global setup refused: ${why}`);
  };
  if (env.NODE_ENV === 'production') fail('NODE_ENV is production');
  if (env.APP_ENV === 'production') fail('APP_ENV is production');
  if (env.REAL_DATA === 'true') fail('REAL_DATA is true');
  if (E2E_DATABASE !== 'belgobeton_e2e') fail('the e2e database name is not the expected one');
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return fail('a connection string cannot be read');
    }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname))
      fail(`host ${u.hostname} is not a loopback host`);
    if (u.pathname.replace(/^\//, '') !== E2E_DATABASE)
      fail(`database ${u.pathname.replace(/^\//, '')} is not the e2e database`);
  }
}
