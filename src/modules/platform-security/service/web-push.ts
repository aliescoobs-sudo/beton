import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { SYSTEM_ACTOR_ID } from '../auth/actors';

// R5: web push to the installed PWA (iPhone included), without any content. A push with an empty body is a wake-up: the service
// worker shows a generic line ("BELGOBETON: you have an alert") and the person opens the app to read it. Nothing the notification
// says, no name and no figure, ever travels through the push service. The request is authenticated by VAPID (RFC 8292).

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const b64u = (b: Buffer) => b.toString('base64url');

function privateKeyObject(v: VapidKeys): KeyObject {
  const pub = Buffer.from(v.publicKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4)
    throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 point');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: v.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** The ES256 JWT of a VAPID request to `audience` (the origin of the push service). */
export function vapidJwt(v: VapidKeys, audience: string, nowSeconds: number): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(
    Buffer.from(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 3600, sub: v.subject })),
  );
  const signer = createSign('SHA256');
  signer.update(`${head}.${body}`);
  const sig = signer.sign({ key: privateKeyObject(v), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

export function vapidFromEnv(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@belgobeton.invalid',
  };
}

export interface PushDeps {
  systemPool: pg.Pool;
  vapid: VapidKeys | null;
  fetch?: typeof fetch;
  nowSeconds?: () => number;
}

/**
 * Sends one bare wake-up per subscription whose person has a notification not yet pushed. Failures never throw: a gone
 * subscription (404, 410) is removed, other failures are counted and the subscription is skipped after five.
 */
export async function flushPush(deps: PushDeps): Promise<{ sent: number; failed: number; removed: number }> {
  const out = { sent: 0, failed: 0, removed: 0 };
  if (!deps.vapid) return out;
  const send = deps.fetch ?? fetch;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(realClock.now().getTime() / 1000));
  const ctx = { userId: SYSTEM_ACTOR_ID, role: 'system' as const, requestId: uuidv7(realClock.now()) };
  const subs = await withRlsContext(deps.systemPool, ctx, (tx) =>
    tx.query<{ subscription_id: string; endpoint: string; p256dh: string; auth: string }>(
      'select * from public.push_outbox(100)',
    ),
  );
  for (const s of subs.rows) {
    let ok = false;
    let gone = false;
    try {
      const url = new URL(s.endpoint);
      const jwt = vapidJwt(deps.vapid, url.origin, nowSeconds());
      const res = await send(s.endpoint, {
        method: 'POST',
        headers: {
          authorization: `vapid t=${jwt}, k=${deps.vapid.publicKey}`,
          ttl: '86400',
          urgency: 'high',
          'content-length': '0',
        },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      ok = res.status >= 200 && res.status < 300;
      gone = res.status === 404 || res.status === 410;
    } catch {
      ok = false;
    }
    await withRlsContext(deps.systemPool, { ...ctx, requestId: uuidv7(realClock.now()) }, (tx) =>
      tx.query('select public.push_result($1, $2, $3)', [s.subscription_id, ok, gone]),
    );
    if (ok) out.sent++;
    else if (gone) out.removed++;
    else out.failed++;
  }
  return out;
}
