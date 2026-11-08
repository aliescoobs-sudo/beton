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
/** The database of the application's former name (BELGOBETON). Never read or written any more; every wipe deletes it (delete-only). */
export const LEGACY_DB = 'belgobeton-field';
const STORE = 'photos';

/** Deletes the former-named database so no photo from a phone that used the old name survives a sign-out. Never throws. */
export function deleteLegacyPhotoStore(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(LEGACY_DB);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
  await new Promise<void>((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  if (stillCurrent()) return true;
  await dropPhoto(row.key).catch(() => undefined);
  return false;
}
export const queuedPhotos = () => run<QueuedPhoto[]>('readonly', (s) => s.getAll());
/**
 * Erases the photos within the scope in ONE transaction (R14-06, R15A-03): the photos of one account, of all but one, or all of them,
 * and ONLY those stamped at or before `cutoff`, which the wipe captured when it started. A negative owner predicate ("all but B") that
 * runs late is therefore never the authority to erase what a later session queued.
 */
export async function wipePhotos(
  scope: WipeScope = 'everything',
  cutoff: number = nextPhotoSeq(),
): Promise<void> {
  await deleteLegacyPhotoStore();
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const row = c.value as QueuedPhoto;
      const inScope =
        scope === 'everything'
          ? true
          : 'only' in scope
            ? row.userId === scope.only
            : row.userId !== scope.except;
      if (inScope && (row.seq ?? 0) <= cutoff) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const dropPhoto = (key: string) => run('readwrite', (s) => s.delete(key)).then(() => undefined);

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
