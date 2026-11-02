import { cookies } from 'next/headers';
import { getRequestClock } from '@/app/request-clock';
import { getEnv } from '@/lib/server-env';
import { FIELD_COOKIE, loginDriver } from '@/modules/field';
import { fieldJson, fieldRoute } from '../context';

// @permission none (the phone signs in with the driver code, a PIN and its own device id): five wrong PINs lock the driver
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: false }, async ({ deps }) => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const result = await loginDriver(
      deps,
      { code: body?.code, pin: body?.pin, deviceId: body?.deviceId, deviceLabel: body?.deviceLabel },
      (await getRequestClock()).now(),
    );
    if (!result.ok) {
      // The same status for a wrong code and a wrong PIN; a lock and a foreign phone are told, they need an action from the owner.
      return fieldJson(result.error === 'LOCKED' || result.error === 'OTHER_DEVICE' ? 403 : 401, {
        error: result.error,
      });
    }
    (await cookies()).set(FIELD_COOKIE, result.value.token, {
      httpOnly: true,
      secure: getEnv().APP_BASE_URL.startsWith('https://'),
      // Lax: the app is opened from a home-screen icon or a link (a top-level navigation); writes are protected by the origin check.
      sameSite: 'lax',
      path: '/',
      maxAge: result.value.maxAgeSeconds,
    });
    return fieldJson(200, { kind: result.value.kind });
  });
}
