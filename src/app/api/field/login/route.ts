import { cookies } from 'next/headers';
import { getRequestClock } from '@/app/request-clock';
import { getEnv } from '@/lib/server-env';
import { FIELD_COOKIE, loginDriver } from '@/modules/field';
import { clientIp, ipIsLocked, readParameters, recordLogin } from '@/modules/platform-security';
import { getPool } from '@/lib/db/pools';
import { fieldJson, fieldRoute } from '../context';

// @permission none (the phone signs in with the driver code, a PIN and its own device id): five wrong PINs lock the driver
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: false }, async ({ deps }) => {
    // R11-01: a per-IP limit in front of the per-driver lock (same parameters as the office sign-in). The IP is the entry the
    // trusted proxy appended (TRUSTED_PROXY_HOPS); unknown means the IP limit is skipped, the driver lock still applies.
    const env = getEnv();
    const clock = await getRequestClock();
    const guard = {
      pool: getPool('auth'),
      hmacKey: env.LOOKUP_HMAC_KEY,
      clock,
      parameters: () => readParameters(getPool('auth')),
    };
    const ip = clientIp(request.headers, env.TRUSTED_PROXY_HOPS);
    if (await ipIsLocked(guard, ip)) {
      return fieldJson(429, { error: 'LOCKED' }, { 'retry-after': '900' });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const result = await loginDriver(
      deps,
      { code: body?.code, pin: body?.pin, deviceId: body?.deviceId, deviceLabel: body?.deviceLabel },
      (await getRequestClock()).now(),
    );
    if (!result.ok && result.error !== 'LOCKED') await recordLogin(guard, 'field-phone', ip, false);
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
