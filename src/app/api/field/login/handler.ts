import { type FieldAuthDeps, loginDriver } from '@/modules/field';
import {
  clientIp,
  type LoginGuardDeps,
  releaseFieldAttempt,
  reserveFieldAttempt,
} from '@/modules/platform-security';

// The phone sign-in, apart from Next's request scope so a test can fire real HTTP requests at it (R12-03).

/** At most this many sign-ins are being verified (Argon2) at once in this process; the others are told to retry at once. */
export const MAX_IN_FLIGHT = 8;

export interface LoginIo {
  deps: FieldAuthDeps;
  guard: LoginGuardDeps;
  trustedHops: number;
  now: Date;
  setCookie: (token: string, maxAgeSeconds: number) => Promise<void>;
  maxInFlight?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'private, no-store', ...headers } });

let inFlight = 0;

export async function handleFieldLogin(request: Request, io: LoginIo): Promise<Response> {
  if (inFlight >= (io.maxInFlight ?? MAX_IN_FLIGHT))
    return json(503, { error: 'BUSY' }, { 'retry-after': '2' });
  inFlight++;
  try {
    // R11-01 / R12-03: the per-IP limit is an atomic reservation made BEFORE the expensive work. The IP is the entry the trusted
    // proxy appended (TRUSTED_PROXY_HOPS); an unknown or malformed one shares one "unknown" bucket, it is never "not locked".
    const ip = clientIp(request.headers, io.trustedHops);
    const reservation = await reserveFieldAttempt(io.guard, ip);
    if (!reservation) return json(429, { error: 'LOCKED' }, { 'retry-after': '900' });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    // An attempt that ends in an unexpected error keeps its reservation: it still counts.
    const result = await loginDriver(
      io.deps,
      { code: body?.code, pin: body?.pin, deviceId: body?.deviceId, deviceLabel: body?.deviceLabel },
      io.now,
    );
    if (!result.ok) {
      // The same status for a wrong code and a wrong PIN; a lock and a foreign phone are told, they need an action from the owner.
      return json(result.error === 'LOCKED' || result.error === 'OTHER_DEVICE' ? 403 : 401, {
        error: result.error,
      });
    }
    await releaseFieldAttempt(io.guard, ip, reservation); // a correct sign-in gives back ITS OWN reservation (R13-02)
    await io.setCookie(result.value.token, result.value.maxAgeSeconds);
    return json(200, { kind: result.value.kind });
  } finally {
    inFlight--;
  }
}
