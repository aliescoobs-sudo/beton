// Client only. The photos of signed BLs wait in the phone's IndexedDB until the server has them (a photo is too big for the
// localStorage queue of the taps). Nothing here is trusted by the server: it checks type, bytes, rotation and time again.
import { fitWithin, photoVerdict, type PhotoVerdict } from '../domain/photo';
import type { WipeScope } from './day-controller';

export interface QueuedPhoto {
  key: string;
  tripId: string;
  takenAt: string;
  blob: Blob;
  /** The account that took it: another account never sends it, and signing out or switching account erases it (F02). */
  userId: string;
  /**
   * R15A-03: a creation stamp, taken when the photo is queued (before any wait), increasing within and across page loads. A wipe
   * captures a cutoff when it STARTS and erases only photos stamped at or before it; a photo without a stamp (older than this field)
   * counts as old.
   */
  seq?: number;
}

let lastSeq = 0;
/** The next creation stamp. Also the cutoff a wipe captures when it starts: nothing queued after that moment is at or below it. */
export function nextPhotoSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}

const DB = 'kayas-field';
/** The database of the application's former name (BELGOBETON). Its unsent photos are migrated to the new database, then it is deleted. */
export const LEGACY_DB = 'belgobeton-field';
const STORE = 'photos';
/** R16-02: set while the deletion of the former database is not proven to be finished (blocked or failed); retried on next load and before any wipe. */
export const LEGACY_PENDING_KEY = 'kayas_legacy_cleanup_pending';

/** What happened to the deletion of the former database. Only `deleted` is a success: `blocked` (another page holds it open) and `error` are not. */
export type LegacyOutcome = 'deleted' | 'blocked' | 'error';

const flag = {
  set: () => {
    try {
      localStorage.setItem(LEGACY_PENDING_KEY, '1');
    } catch {
      // no localStorage here: the state is then only what the database itself shows
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(LEGACY_PENDING_KEY);
    } catch {
      // see above
    }
  },
  isSet: () => {
    try {
      return localStorage.getItem(LEGACY_PENDING_KEY) === '1';
    } catch {
      return false;
    }
  },
};

/** A deletion asked by this page is queued behind an old page's connection: the database is not opened again meanwhile (the open would wait). */
let deletionQueued = false;

/** True while the former database may still be on this phone: show it, and it is retried before any wipe. */
export const legacyCleanupPending = (): boolean => flag.isSet();

/**
 * Asks for the deletion of the former-named database. `deleted` only when the browser says the deletion is done. `blocked` when another open
 * connection (an old page) holds it: the request stays queued in the browser and finishes when that page closes, but this call does NOT
 * count that as success: the pending state is kept and the deletion is retried. `error` otherwise. Never throws.
 */
export function deleteLegacyPhotoStore(): Promise<LegacyOutcome> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(LEGACY_DB);
      let settled = false;
      const settle = (outcome: LegacyOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      req.onsuccess = () => {
        deletionQueued = false;
        flag.clear(); // also when the browser finishes a deletion that was blocked earlier, once the old page is closed
        settle('deleted');
      };
      req.onerror = () => {
        deletionQueued = false;
        flag.set();
        settle('error');
      };
      req.onblocked = () => {
        // the request stays queued in the browser: until it finishes, opening that database waits behind it, so this page does not reopen it
        deletionQueued = true;
        flag.set();
        settle('blocked');
      };
    } catch {
      flag.set();
      resolve('error');
    }
  });
}

/** Does the former database exist on this phone? (Opening a missing one would create it.) */
async function legacyExists(): Promise<boolean> {
  if (typeof indexedDB.databases === 'function') {
    return (await indexedDB.databases()).some((d) => d.name === LEGACY_DB);
  }
  return true; // cannot be told: the open below aborts and deletes a database it had to create
}

/**
 * Opens the former database; it closes itself when another page wants to delete or upgrade it, so it never blocks that. Null when it did not
 * exist (nothing is created: the upgrade is aborted) or when the browser did not answer in time (the open waits behind a queued deletion).
 */
function openLegacy(): Promise<IDBDatabase | null> {
  if (deletionQueued) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, 1500);
    const req = indexedDB.open(LEGACY_DB);
    let created = false;
    req.onupgradeneeded = () => {
      created = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => db.close();
      if (timedOut || created || !db.objectStoreNames.contains(STORE)) {
        db.close();
        if (!timedOut) resolve(null);
      } else resolve(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (!timedOut) created ? resolve(null) : reject(req.error);
    };
    req.onblocked = () => undefined;
  });
}

function readAll(db: IDBDatabase): Promise<QueuedPhoto[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedPhoto[]);
    req.onerror = () => reject(req.error);
  });
}

/** The unsent photos still in the former database (read only; none when it is gone). */
async function legacyRows(): Promise<QueuedPhoto[]> {
  if (!(await legacyExists())) return [];
  const db = await openLegacy();
  if (!db) return [];
  try {
    return await readAll(db);
  } finally {
    db.close();
  }
}

/**
 * R16-02, step 1: the unsent photos of a phone that used the former name are COPIED into the new database, keeping their owner (another account
 * never sends them, and a wipe of that account erases them). A row without a creation stamp counts as old. Nothing is deleted here.
 * `none`: there was nothing; `error`: the copy is not committed (the former rows stay, and `queuedPhotos` still lists them).
 */
async function copyLegacyPhotos(): Promise<'none' | 'copied' | 'error'> {
  if (deletionQueued || !(await legacyExists())) return 'none';
  const rows = await legacyRows().catch(() => null);
  if (rows === null) return 'error';
  if (rows.length === 0) return 'copied';
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const row of rows) {
        // a photo already in the new database (an interrupted copy) is not overwritten
        const exists = store.getKey(row.key);
        exists.onsuccess = () => {
          if (exists.result === undefined) store.put({ ...row, seq: row.seq ?? 0 });
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    return 'error';
  } finally {
    db.close();
  }
  // The copy is committed: the former rows are taken out of the former database BEFORE its deletion is asked. A deletion that is blocked stays
  // queued and that database cannot be opened again meanwhile, so it must not keep any photo while it waits. A failure here is not fatal:
  // the rows stay (and are never lost), and the outcome of the deletion is still reported.
  const legacy = await openLegacy().catch(() => null);
  if (legacy) {
    await new Promise<void>((resolve) => {
      const tx = legacy.transaction(STORE, 'readwrite');
      for (const row of rows) tx.objectStore(STORE).delete(row.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    }).finally(() => legacy.close());
  }
  return 'copied';
}

/**
 * Copies the former database's photos, then (only when the copy is committed) asks for its deletion and returns the outcome. Also the retry of
 * a pending deletion. `none` when there is no former database. A failed copy is `error` and nothing is deleted.
 */
export async function migrateLegacyPhotos(): Promise<LegacyOutcome | 'none'> {
  if (deletionQueued) return 'blocked'; // already asked by this page; the browser finishes it when the old page closes
  const copied = await copyLegacyPhotos();
  if (copied === 'none') {
    if (!(await legacyExists().catch(() => true))) flag.clear();
    return flag.isSet() ? 'blocked' : 'none';
  }
  if (copied === 'error') {
    flag.set();
    return 'error';
  }
  return deleteLegacyPhotoStore();
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * R15B-04: a request that succeeded is not a write that is durable. A readwrite operation is finished when its TRANSACTION completes; an abort
 * (or an error) after the request's success rejects. A readonly read has nothing to commit, so its result is returned when the request succeeds.
 */
function finish<T>(tx: IDBTransaction, req: IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    tx.onabort = () => reject(tx.error ?? req.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error ?? req.error);
    if (mode === 'readonly') req.onsuccess = () => resolve(req.result);
    else tx.oncomplete = () => resolve(req.result);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return finish(tx, req, mode).finally(() => db.close());
}

/**
 * R15A-04: `stillCurrent` is asked AFTER the (possibly slow) database opening and in the same synchronous step that issues the write,
 * so a session that ended while the photo was being prepared or the database was opening never gets its photo stored. If the session
 * ends while the write is on its way, the row is taken out again. Answers whether the photo was kept.
 */
export async function queuePhoto(p: QueuedPhoto, stillCurrent: () => boolean = () => true): Promise<boolean> {
  const row: QueuedPhoto = { ...p, seq: p.seq ?? nextPhotoSeq() };
  const db = await open();
  if (!stillCurrent()) return false;
  const tx = db.transaction(STORE, 'readwrite');
  await finish(tx, tx.objectStore(STORE).put(row), 'readwrite');
  if (stillCurrent()) return true;
  // The session ended while the write was on its way: take the row out again. A failed removal is NOT swallowed, because the row
  // would still be on the phone (R15B-04): the caller must not treat the sign-out as erased.
  try {
    await dropPhoto(row.key);
  } catch {
    throw new Error('photo cleanup failed: the stale photo may still be stored');
  }
  return false;
}
/**
 * Every unsent photo of this phone. A leftover of the former database is migrated first (and its deletion retried when it is still pending);
 * whatever could not be moved yet is still listed, so it is counted by the sign-out confirmation and never silently lost.
 */
export async function queuedPhotos(): Promise<QueuedPhoto[]> {
  if (flag.isSet() || (await legacyExists().catch(() => false)))
    await migrateLegacyPhotos().catch(() => undefined);
  const rows = await run<QueuedPhoto[]>('readonly', (s) => s.getAll());
  const known = new Set(rows.map((r) => r.key));
  const left = (await legacyRows().catch(() => [] as QueuedPhoto[])).filter((r) => !known.has(r.key));
  return [...rows, ...left];
}
/**
 * Erases the photos within the scope in ONE transaction (R14-06, R15A-03): the photos of one account, of all but one, or all of them,
 * and ONLY those stamped at or before `cutoff`, which the wipe captured when it started. A negative owner predicate ("all but B") that
 * runs late is therefore never the authority to erase what a later session queued.
 */
export async function wipePhotos(
  scope: WipeScope = 'everything',
  cutoff: number = nextPhotoSeq(),
): Promise<{ legacy: LegacyOutcome | 'none' }> {
  // R16-02: copy the former database's photos first, so the same scope and cutoff apply to them. The rows in scope are erased from BOTH
  // databases BEFORE the deletion of the former one is asked (once a deletion is queued, that database cannot be opened again until it
  // finishes). Then the deletion is asked and its outcome is returned: blocked and error are not success.
  const copied = await copyLegacyPhotos().catch((): 'error' => 'error');
  const inScope = (row: QueuedPhoto) =>
    (scope === 'everything'
      ? true
      : 'only' in scope
        ? row.userId === scope.only
        : row.userId !== scope.except) && (row.seq ?? 0) <= cutoff;
  await erase(await open(), inScope);
  if (copied === 'none') return { legacy: flag.isSet() ? 'blocked' : 'none' };
  const legacy = await (async (): Promise<LegacyOutcome> => {
    const db = await openLegacy().catch(() => null);
    if (db) await erase(db, inScope).catch(() => undefined);
    if (copied === 'error') {
      flag.set();
      return 'error'; // rows that could not be copied stay in the former database: never deleted as if they had been moved
    }
    return deleteLegacyPhotoStore();
  })();
  return { legacy };
}

/** Erases the rows in scope in ONE transaction, then closes the connection. */
function erase(db: IDBDatabase, inScope: (row: QueuedPhoto) => boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (inScope(c.value as QueuedPhoto)) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}
export async function dropPhoto(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
  // a copy still in the former database (blocked deletion) is taken out too, or it would be sent again
  const db = await openLegacy().catch(() => null);
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Re-draws the picture at most 1600 px wide as a JPEG: smaller to send, and the camera metadata (GPS) is not carried over. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.82),
  );
}

export async function sendPhoto(p: QueuedPhoto, signal?: AbortSignal): Promise<PhotoVerdict> {
  const body = new FormData();
  body.set('tripId', p.tripId);
  body.set('key', p.key);
  body.set('takenAt', p.takenAt);
  body.set('photo', new File([p.blob], 'bl.jpg', { type: p.blob.type || 'image/jpeg' }));
  try {
    const res = await fetch('/api/field/bl-photo', { method: 'POST', body, ...(signal ? { signal } : {}) });
    const error = res.ok
      ? undefined
      : ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    return photoVerdict(res.status, error);
  } catch {
    return 'retry';
  }
}
