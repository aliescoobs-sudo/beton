import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { authorize, dropSubscription, saveSubscription, type SessionUser } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

async function gate(
  request: Request,
  write: boolean,
): Promise<{ response: Response } | { user: SessionUser }> {
  const env = getEnv();
  if (!env.NOTIFICATIONS_ENABLED) return { response: json(404, { error: 'NOT_FOUND' }) };
  if (write && request.headers.get('origin') !== new URL(env.APP_BASE_URL).origin)
    return { response: json(403, { error: 'FORBIDDEN' }) };
  const allowed = await authorize('notifications.read', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { response: json(401, { error: 'UNAUTHENTICATED' }) };
  return { user: allowed.user };
}

// @permission notifications.read (every signed-in account): the public key a browser needs to subscribe to push
export async function GET(request: Request): Promise<Response> {
  const g = await gate(request, false);
  if ('response' in g) return g.response;
  return json(200, { publicKey: getEnv().VAPID_PUBLIC_KEY ?? null });
}

// @permission notifications.read (every signed-in account): registers this browser for the caller's own push; same-origin only
export async function POST(request: Request): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const body = await request.json().catch(() => null);
  const r = await saveSubscription(getPool('app'), g.user, body);
  return r.ok ? json(200, { ok: true }) : json(400, { error: r.error });
}

// @permission notifications.read (every signed-in account): drops this browser's push registration (own only)
export async function DELETE(request: Request): Promise<Response> {
  const g = await gate(request, true);
  if ('response' in g) return g.response;
  const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
  const dropped = await dropSubscription(getPool('app'), g.user, String(body?.endpoint ?? ''));
  return json(200, { ok: dropped });
}
