// Client only. The phone's local copies (F02 of the final review): where they live and how they are erased. The day and the queue of
// taps are in localStorage with their owner; the photos of signed BLs are in IndexedDB with theirs; the service worker's Cache Storage
// holds only the app shell and the framework's static files (never the day). `forgetRead` erases what names a client; `forgetAll` also
// erases the work waiting to be sent (an explicit sign-out, or another account taking over the phone).
import type { WipeScope } from './day-controller';
import { wipePhotos } from './photo-queue';

export const QUEUE_KEY = 'bb_field_queue';
export const DAY_KEY = 'bb_field_day';

// The service worker keeps only the app shell and static files (bb-field-v2). Anything from the API, and every older cache version (the
// first one kept the day), is erased; the shell stays so that the app still opens offline to its sign-in.
const SHELL_CACHE = 'bb-field-v2';
async function wipeCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    for (const name of await caches.keys()) {
      if (name !== SHELL_CACHE) {
        await caches.delete(name);
        continue;
      }
      const cache = await caches.open(name);
      for (const req of await cache.keys())
        if (new URL(req.url).pathname.startsWith('/api/')) await cache.delete(req);
    }
  } catch {
    // no Cache Storage here
  }
}

/** The day read from the server and the service worker's caches: everything that shows a client. The queued work stays. */
export async function forgetRead(): Promise<void> {
  localStorage.removeItem(DAY_KEY);
  await wipeCaches();
}

/**
 * The day, the caches, the queue of taps and the photos waiting. The day and the queue go synchronously, before any await; the photos
 * are erased within the scope only (R14-06): a wipe that is delayed by slow storage must not reach the photos a NEWER sign-in queued.
 */
export async function forgetAll(scope: WipeScope = 'everything'): Promise<void> {
  localStorage.removeItem(DAY_KEY);
  localStorage.removeItem(QUEUE_KEY);
  await wipeCaches();
  await wipePhotos(scope).catch(() => undefined);
}
