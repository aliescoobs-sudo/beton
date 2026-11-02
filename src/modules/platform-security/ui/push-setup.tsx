'use client';

import { useState } from 'react';

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Turns on push for this phone (R5). On iPhone the app must first be added to the home screen. The subscription is the
 * person's own; the push carries no content, so what a lock screen shows is the generic line only.
 */
export function PushSetup({
  publicKey,
  keyUrl,
  workerUrl,
  subscribeUrl,
  labels,
}: {
  publicKey: string | null;
  /** Where to fetch the key when it is not known at render time (the phone app). */
  keyUrl?: string;
  workerUrl: string;
  subscribeUrl: string;
  labels: { enable: string; enabled: string; unsupported: string; denied: string; unavailable: string };
}) {
  const [state, setState] = useState<'idle' | 'on' | 'unsupported' | 'denied' | 'unavailable'>('idle');
  async function enable() {
    let key = publicKey;
    if (!key && keyUrl) {
      const got = await fetch(keyUrl)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      key = (got as { publicKey?: string | null } | null)?.publicKey ?? null;
    }
    if (!key) return setState('unavailable');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
    if ((await Notification.requestPermission()) !== 'granted') return setState('denied');
    const reg = await navigator.serviceWorker.register(workerUrl);
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    const res = await fetch(subscribeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    setState(res.ok ? 'on' : 'unavailable');
  }
  return (
    <div className="space-y-2" data-testid="push-setup">
      <button type="button" className="btn" onClick={() => void enable()} data-testid="push-enable">
        {labels.enable}
      </button>
      {state === 'on' && (
        <p role="status" data-testid="push-on">
          {labels.enabled}
        </p>
      )}
      {state === 'unsupported' && <p role="status">{labels.unsupported}</p>}
      {state === 'denied' && <p role="status">{labels.denied}</p>}
      {state === 'unavailable' && <p role="status">{labels.unavailable}</p>}
    </div>
  );
}
