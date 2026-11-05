import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { saveSubscription } from '@/modules/platform-security';
import { fieldJson, fieldRoute } from '../context';

// @permission driver or pump_operator session: the public key a phone needs to subscribe to push
export async function GET(request: Request): Promise<Response> {
  if (getEnv().TRAINING_MODE) return fieldJson(404, { error: 'NOT_FOUND' }); // R11-07: before anything else, session included
  return fieldRoute(request, { write: false, session: true }, async () => {
    // R11-07: the training instance contacts no push provider, so it does not even hand out the key (like /api/push).
    if (!getEnv().NOTIFICATIONS_ENABLED || getEnv().TRAINING_MODE)
      return fieldJson(404, { error: 'NOT_FOUND' });
    return fieldJson(200, { publicKey: getEnv().VAPID_PUBLIC_KEY ?? null });
  });
}

// @permission driver or pump_operator session: registers this phone for the driver's own push (a bare wake-up, no content)
export async function POST(request: Request): Promise<Response> {
  if (getEnv().TRAINING_MODE) return fieldJson(404, { error: 'NOT_FOUND' });
  return fieldRoute(request, { write: true, session: true }, async ({ user }) => {
    if (!user || !getEnv().NOTIFICATIONS_ENABLED || getEnv().TRAINING_MODE)
      return fieldJson(404, { error: 'NOT_FOUND' });
    const r = await saveSubscription(getPool('app'), user, await request.json().catch(() => null));
    return r.ok ? fieldJson(200, { ok: true }) : fieldJson(400, { error: r.error });
  });
}
