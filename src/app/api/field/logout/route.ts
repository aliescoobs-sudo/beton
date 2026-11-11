import { cookies } from 'next/headers';
import { getRequestClock } from '@/app/request-clock';
import { getEnv } from '@/lib/server-env';
import { closeFieldSession, FIELD_COOKIE, verifyFieldToken } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission none (ends the phone session on the SERVER, by moving the session generation of the bound phone; the response sets no cookie, R19-04)
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: false }, async ({ deps }) => {
    // R15A-01: idempotent. A logout that carries no phone cookie has nothing to end and sets NO header, so a repeated or late logout
    // that finds the cookie already gone (or never set) changes nothing. The client also never sends a login while a logout is on
    // its way, and aborts a logout after a deadline; a response header of an aborted request is never applied by the browser.
    const jar = await cookies();
    const raw = jar.get(FIELD_COOKIE)?.value;
    if (!raw) return fieldJson(200, { ok: true });
    // T10c: the server ends the session first. A failure answers 503 and leaves the cookie, so the client keeps its pending sign-out and
    // retries (a sign-out the server did not record is not reported as done). An expired or forged token has nothing to end.
    const token = verifyFieldToken(
      getEnv().AUTH_SECRET,
      raw,
      Math.floor((await getRequestClock()).now().getTime() / 1000),
    );
    if (token) {
      let closed: boolean;
      try {
        closed = await closeFieldSession(deps, token);
      } catch {
        return fieldJson(503, { error: 'UNAVAILABLE' }, { 'retry-after': '5' });
      }
      // R18-05 / R19-04: whether the compare-and-set found the live session (and ended it) or a newer one, THE SERVER'S REVOCATION STANDS and this response never carries
      // a Set-Cookie. The cookie in the browser is shared by every tab: a deletion header that arrives after another tab signed in would sign that tab out, and no
      // locking on the phone can order a response header. The revoked cookie left behind is harmless (the next check answers "ended"), the next sign-in overwrites it,
      // and the client clears its own local state. The same holds for an expired or invalid token: there is nothing to end and nothing to clear.
      void closed;
    }
    return fieldJson(200, { ok: true });
  });
}
