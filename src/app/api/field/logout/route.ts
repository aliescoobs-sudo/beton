import { cookies } from 'next/headers';
import { FIELD_COOKIE } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission none (ends the phone session on this phone; the bound phone stays bound)
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: false }, async () => {
    (await cookies()).delete(FIELD_COOKIE);
    return fieldJson(200, { ok: true });
  });
}
