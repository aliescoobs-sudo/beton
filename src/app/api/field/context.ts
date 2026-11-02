import { cookies } from 'next/headers';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { FIELD_COOKIE, type FieldAuthDeps, sessionOfToken, verifyFieldToken } from '@/modules/field';
import { getAuth, type SessionUser } from '@/modules/platform-security';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'private, no-store', ...headers } });

export const fieldJson = json;

export function fieldDeps(): FieldAuthDeps {
  return {
    appPool: getPool('app'),
    authPool: getPool('auth'),
    auth: getAuth(),
    secret: getEnv().AUTH_SECRET,
  };
}

/**
 * The door of the phone app endpoints. With the module flag off nothing below it runs: a plain 404. A write is accepted only
 * from this application's own origin; a read or a write needs a valid phone session (the database re-checks the driver and
 * the bound phone on every request).
 */
export async function fieldRoute(
  request: Request,
  opts: { write: boolean; session: boolean },
  run: (ctx: { user: SessionUser | null; today: string; deps: FieldAuthDeps }) => Promise<Response>,
): Promise<Response> {
  const env = getEnv();
  if (!env.FIELD_APP_ENABLED) return json(404, { error: 'NOT_FOUND' });
  if (opts.write && request.headers.get('origin') !== new URL(env.APP_BASE_URL).origin) {
    return json(403, { error: 'FORBIDDEN' });
  }
  const deps = fieldDeps();
  const today = (await getRequestClock()).today();
  if (!opts.session) return run({ user: null, today, deps });
  const token = verifyFieldToken(
    env.AUTH_SECRET,
    (await cookies()).get(FIELD_COOKIE)?.value,
    Math.floor((await getRequestClock()).now().getTime() / 1000),
  );
  const user = token ? await sessionOfToken(deps, token) : null;
  if (!user) return json(401, { error: 'UNAUTHENTICATED' });
  return run({ user, today, deps });
}
