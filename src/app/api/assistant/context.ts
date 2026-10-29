import { getEngineParams } from '@/app/engine-params';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { defaultCipher } from '@/modules/assistant/service/cipher';
import type { EndpointContext, EndpointResponse } from '@/modules/assistant/service/endpoints';
import { loadLeakIndex } from '@/modules/assistant/service/leak-index';
import { providerFor } from '@/modules/assistant/service/provider-factory';
import { authorize, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { readParameters } from '@/modules/platform-security/service/parameter-service';

const json = (r: EndpointResponse): Response =>
  Response.json(r.body, { status: r.status, headers: { 'cache-control': 'private, no-store' } });

/**
 * The door of every assistant endpoint. With the flag off nothing below it runs: a plain 404, as if the route did not exist. A
 * write is accepted only from this application's own origin (these are not Server Actions, so Next does not check it for us),
 * only from a signed-in, enrolled user whose role holds `assistant.use`; anyone else gets the same 404.
 */
export async function assistantRoute(
  request: Request,
  { write }: { write: boolean },
  run: (ctx: EndpointContext) => Promise<EndpointResponse>,
): Promise<Response> {
  const env = getEnv();
  if (!env.ASSISTANT_ENABLED) return json({ status: 404, body: { error: 'NOT_FOUND' } });
  if (write) {
    const origin = request.headers.get('origin');
    if (origin !== new URL(env.APP_BASE_URL).origin)
      return json({ status: 403, body: { error: 'FORBIDDEN' } });
  }
  const allowed = await authorize('assistant.use', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok)
    return json({ status: allowed.reason === 'UNAUTHENTICATED' ? 401 : 404, body: { error: 'NOT_FOUND' } });
  const today = (await getRequestClock()).today();
  const cipher = defaultCipher();
  return json(
    await run({
      enabled: true,
      user: allowed.user,
      appPool: getPool('app'),
      authPool: getPool('auth'),
      systemPool: getPool('system'),
      cipher,
      hmacKey: env.LOOKUP_HMAC_KEY,
      today,
      engine: await getEngineParams(),
      model: env.ASSISTANT_MODEL,
      provider: () => providerFor(env, today),
      leakIndex: () => loadLeakIndex(getPool('system'), cipher),
      stepUp: (fn) =>
        withStepUp('ai.confirm_command', fn, {
          getState: currentAuthState,
          parameters: () => readParameters(getPool('auth')),
        }),
    }),
  );
}

export async function bodyOf(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return undefined;
  return request.json().catch(() => undefined);
}
