// Client only. The phone's local copies (F02 of the final review): where they live and how they are erased. The day and the queue of
// taps are in localStorage with their owner; the photos of signed BLs are in IndexedDB with theirs; the service worker's Cache Storage
// holds only the app shell and the framework's static files (never the day). `forgetRead` erases what names a client; `forgetAll` also
// erases the work waiting to be sent (an explicit sign-out, or another account taking over the phone).
import type { WipeScope } from './day-controller';
import {
  legacyCleanupPending,
  LEGACY_PENDING_KEY,
  reserveEpoch,
  wipePhotos,
  type WipeResult,
} from './photo-queue';

export { legacyCleanupPending, LEGACY_PENDING_KEY };

export const QUEUE_KEY = 'bb_field_queue';
export const DAY_KEY = 'bb_field_day';
/**
 * T10c (R17-08): set when an erase of this phone's photos is not proven to be finished (a store could not be opened, read or written, the
 * lock could not be had, the former database is still held open). It holds the scope to retry, never a photo, and is cleared only by an erase
 * that reports `complete`. A reload retries it, and the screen says so while it is set.
 */
export const ERASE_PENDING_KEY = 'kayas_erase_pending';
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

/** What an erase achieved. `complete` is true only when nothing is left to retry; it never claims more. */
export interface ForgetResult {
  complete: boolean;
  legacyCleanupPending: boolean;
  failed: WipeResult['failed'];
  /** R18-06: an erase is owed but could not be written to the phone's storage: a reload would forget it. */
  persistFailed?: boolean;
}

interface Owed {
  scope: WipeScope;
  /** The cutoff of the ORIGINAL wipe: a retry never reaches what was queued after that wipe began. */
  cutoff: number | null;
}
/**
 * R18-06: when localStorage cannot hold the owed erase (full, blocked, private mode) the debt is kept HERE, in memory, and the failure is reported
 * (`ForgetResult.persistFailed`): the erase is still retried while the page lives, and the caller shows that a reload would lose the memory of it.
 */
let memoryOwed: Owed[] = [];
let persistFailedLast = false;
const storedOwed = (): Owed[] => {
  try {
    const v = JSON.parse(localStorage.getItem(ERASE_PENDING_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as Owed[]) : [];
  } catch {
    return [];
  }
};
const pendingOwed = (): Owed[] => {
  const stored = storedOwed();
  return [...stored, ...memoryOwed.filter((m) => !stored.some((o) => sameScope(o.scope, m.scope)))];
};
const sameScope = (a: WipeScope, b: WipeScope) => JSON.stringify(a) === JSON.stringify(b);
/** Is an erase still owed on this phone? (From the persistent flag, so it survives a reload.) */
export const erasePending = (): boolean => pendingOwed().length > 0;
function setPending(owed: Owed, complete: boolean): void {
  const rest = pendingOwed().filter((o) => !sameScope(o.scope, owed.scope));
  const next = complete ? rest : [...rest, owed];
  memoryOwed = next; // the memory always holds the truth of this page
  try {
    if (next.length) localStorage.setItem(ERASE_PENDING_KEY, JSON.stringify(next));
    else localStorage.removeItem(ERASE_PENDING_KEY);
    persistFailedLast = false;
    if (!next.length) memoryOwed = [];
  } catch {
    // R18-06: not durable. Kept in memory and SURFACED, never silently dropped.
    persistFailedLast = true;
  }
}
/** Was the last change of the owed-erase record impossible to persist? A reload would then forget that an erase is owed. */
export const erasePendingNotPersisted = (): boolean => persistFailedLast && memoryOwed.length > 0;

/**
 * The day, the caches, the queue of taps and the photos waiting. The day and the queue go synchronously, before any await; the photos
 * are erased within the scope AND up to the cutoff taken from the persistent epoch at the start (R14-06, R15A-03, T10c): a wipe delayed by
 * slow storage never reaches the photos queued after it began, whoever queued them. A failure of any store is RETURNED and kept as a pending
 * erase (never swallowed): the caller shows it and retries; it never reports an erasure that did not happen.
 */
export async function forgetAll(
  scope: WipeScope = 'everything',
  retryCutoff: number | null = null,
): Promise<ForgetResult> {
  localStorage.removeItem(DAY_KEY);
  localStorage.removeItem(QUEUE_KEY);
  // The owed erase is written BEFORE the work starts: if the page dies in the middle, the next load still knows.
  let cutoff: number;
  try {
    // R15A-03: the cutoff is taken before any wait of the photo erase. Whatever is queued after this moment is not this wipe's to erase.
    cutoff = retryCutoff ?? (await reserveEpoch());
  } catch {
    setPending({ scope, cutoff: null }, false);
    return {
      complete: false,
      legacyCleanupPending: legacyCleanupPending(),
      failed: ['new-store'],
      persistFailed: erasePendingNotPersisted(),
    };
  }
  setPending({ scope, cutoff }, false);
  await wipeCaches();
  const wiped = await wipePhotos(scope, cutoff);
  setPending({ scope, cutoff }, wiped.complete);
  return {
    complete: wiped.complete,
    legacyCleanupPending: legacyCleanupPending(),
    failed: wiped.failed,
    persistFailed: erasePendingNotPersisted(),
  };
}

/** Retries every erase that is still owed (on load, and when the driver asks). Resolves with whether none is left. */
export async function retryPendingErase(): Promise<ForgetResult> {
  const results: ForgetResult[] = [];
  for (const { scope, cutoff } of pendingOwed()) results.push(await forgetAll(scope, cutoff));
  return {
    complete: results.every((r) => r.complete) && !erasePending(),
    legacyCleanupPending: legacyCleanupPending(),
    failed: results.flatMap((r) => r.failed),
    persistFailed: erasePendingNotPersisted(),
  };
}
