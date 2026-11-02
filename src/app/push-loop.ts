import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { flushPush, vapidFromEnv } from '@/modules/platform-security';

/** R5: every 20 seconds, one bare wake-up per phone with something new. Without a VAPID key pair nothing is scheduled. */
export function startPushLoop(): void {
  const env = getEnv();
  const vapid = vapidFromEnv(env);
  if (!env.NOTIFICATIONS_ENABLED || !vapid) return;
  const tick = () =>
    flushPush({ systemPool: getPool('system'), vapid }).catch((error: unknown) => {
      console.warn('push flush failed', error instanceof Error ? error.message : String(error));
    });
  const timer = setInterval(() => void tick(), 20_000);
  timer.unref();
}
