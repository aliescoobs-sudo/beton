// Client only. The phone's local copies (F02 of the final review): where they live and how they are erased. The day and the queue of
// taps are in localStorage with their owner; the photos of signed BLs are in IndexedDB with theirs; the service worker's Cache Storage
// holds only the app shell and the framework's static files (never the day). `forgetRead` erases what names a client; `forgetAll` also
// erases the work waiting to be sent (an explicit sign-out, or another account taking over the phone).
import type { WipeScope } from './day-controller';
import { nextPhotoSeq, wipePhotos } from './photo-queue';

export const QUEUE_KEY = 'bb_field_queue';
export const DAY_KEY = 'bb_field_day';
/** R15B-02: set when this phone signed out and the server has not confirmed it (it holds no data; a wipe does not remove it). */
export const SIGNED_OUT_KEY = 'bb_field_signed_out';

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
 * are erased within the scope AND up to the cutoff captured at the start (R14-06, R15A-03): a wipe delayed by slow storage never reaches the
 * photos queued after it began, whoever queued them.
 */
export async function forgetAll(scope: WipeScope = 'everything'): Promise<void> {
  // R15A-03: the cutoff is taken NOW, before any wait. Whatever is queued after this moment is not this wipe's to erase.
  const cutoff = nextPhotoSeq();
  localStorage.removeItem(DAY_KEY);
  localStorage.removeItem(QUEUE_KEY);
  await wipeCaches();
  await wipePhotos(scope, cutoff).catch(() => undefined);
}
