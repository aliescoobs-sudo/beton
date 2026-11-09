import { createHash } from 'node:crypto';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { allowRead } from '@/lib/read-limit';
import { getEnv } from '@/lib/server-env';
import { isRealDate } from '@/modules/ledger';
import { getTripStages } from '@/modules/operations';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const headers = (extra: Record<string, string> = {}) => ({ 'cache-control': 'private, no-store', ...extra });

/**
 * The live refresh of the plant's board (T9): the shared status of a day's rotations, with an ETag over its content, so a 12-second poll costs
 * a 304 while nothing changed. The page asks with `If-None-Match` and refreshes itself when the tag moves.
 * Door: a signed-in, enrolled user whose role holds `trips.read`; same-origin only (the browser says so in Sec-Fetch-Site, or Origin matches);
 * at most 60 reads a minute per user. The database scopes the rows (a plant manager sees his plant's rotations).
 */
// @permission trips.read (owner, app_admin, plant manager): the stages of the day's rotations, scoped by the database
export async function GET(request: Request): Promise<Response> {
  const env = getEnv();
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const sameOrigin = site
    ? site === 'same-origin'
    : origin !== null && origin === new URL(env.APP_BASE_URL).origin;
  if (!sameOrigin) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: headers() });
  const allowed = await authorize('trips.read', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok)
    return Response.json(
      { error: allowed.reason === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'FORBIDDEN' },
      { status: allowed.reason === 'UNAUTHENTICATED' ? 401 : 403, headers: headers() },
    );
  const clock = await getRequestClock();
  if (!allowRead(`trips-stages:${allowed.user.id}`, clock.now().getTime()))
    return Response.json({ error: 'TOO_MANY' }, { status: 429, headers: headers({ 'retry-after': '30' }) });
  const asked = new URL(request.url).searchParams.get('date');
  const date = asked && isRealDate(asked) ? asked : clock.today();
  const result = await getTripStages(getPool('app'), allowed.user, date);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400, headers: headers() });
  const text = JSON.stringify(result.value);
  const etag = `W/"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers: headers({ etag }) });
  return new Response(text, { status: 200, headers: headers({ etag, 'content-type': 'application/json' }) });
}
