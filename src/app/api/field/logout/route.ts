import { cookies } from 'next/headers';
import { FIELD_COOKIE } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission none (ends the phone session on this phone; the bound phone stays bound)
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: false }, async () => {
    // R15A-01: idempotent. A logout that carries no phone cookie has nothing to end and sets NO header, so a repeated or late logout
    // that finds the cookie already gone (or never set) changes nothing. The client also never sends a login while a logout is on
    // its way, and aborts a logout after a deadline; a response header of an aborted request is never applied by the browser.
    const jar = await cookies();
    if (jar.get(FIELD_COOKIE)) jar.delete(FIELD_COOKIE);
    return fieldJson(200, { ok: true });
  });
}
