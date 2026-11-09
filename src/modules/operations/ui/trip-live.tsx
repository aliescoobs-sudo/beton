'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * The live refresh of the plant's board (T9): every 11-13 seconds it asks whether the shared status of the day's rotations changed (a 304 costs
 * almost nothing) and refreshes the page when it did. It stops while the tab is hidden and asks at once when the tab comes back.
 * It renders nothing.
 */
export function TripLive({ date }: { date: string }) {
  const router = useRouter();
  const etag = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    async function check() {
      if (stopped || busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const res = await fetch(`/api/trips/stages?date=${encodeURIComponent(date)}`, {
          cache: 'no-store',
          headers: etag.current ? { 'if-none-match': etag.current } : {},
        });
        if (res.status === 200) {
          const next = res.headers.get('etag');
          const first = etag.current === null;
          etag.current = next;
          if (!first) router.refresh();
        }
      } catch {
        // offline or a hiccup: the next tick asks again
      } finally {
        busy = false;
      }
    }
    const loop = () => {
      void check();
      timer = setTimeout(loop, 11_000 + Math.floor(Math.random() * 2_000));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [date, router]);
  return null;
}
