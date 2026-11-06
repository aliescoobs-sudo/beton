import { cookies } from 'next/headers';
import { getRequestClock } from '@/app/request-clock';
import { getEnv } from '@/lib/server-env';
import { FIELD_COOKIE } from '@/modules/field';
import { readParameters } from '@/modules/platform-security';
import { getPool } from '@/lib/db/pools';
import { fieldRoute } from '../context';
import { handleFieldLogin } from './handler';

// @permission none (the phone signs in with the driver code, a PIN and its own device id): five wrong PINs lock the driver
export async function POST(request: Request): Promise<Response> {
  return fieldRoute(request, { write: true, session: false }, async ({ deps }) => {
    const env = getEnv();
    const clock = await getRequestClock();
    return handleFieldLogin(request, {
      deps,
      guard: {
        pool: getPool('auth'),
        hmacKey: env.LOOKUP_HMAC_KEY,
        clock,
        parameters: () => readParameters(getPool('auth')),
      },
      trustedHops: env.TRUSTED_PROXY_HOPS,
      now: clock.now(),
      setCookie: async (token, maxAge) => {
        (await cookies()).set(FIELD_COOKIE, token, {
          httpOnly: true,
          secure: env.APP_BASE_URL.startsWith('https://'),
          // Lax: the app is opened from a home-screen icon or a link (a top-level navigation); writes are protected by the origin check.
          sameSite: 'lax',
          path: '/',
          maxAge,
        });
      },
    });
  });
}
