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
}

const DB = 'belgobeton-field';
const STORE = 'photos';

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

export const queuePhoto = (p: QueuedPhoto) => run('readwrite', (s) => s.put(p)).then(() => undefined);
export const queuedPhotos = () => run<QueuedPhoto[]>('readonly', (s) => s.getAll());
/** Erases the photos within the scope in ONE transaction (R14-06): the photos of one account, of all but one, or all of them. */
export async function wipePhotos(scope: WipeScope = 'everything'): Promise<void> {
  if (scope === 'everything') return void (await run('readwrite', (s) => s.clear()));
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const owner = (c.value as QueuedPhoto).userId;
      if ('only' in scope ? owner === scope.only : owner !== scope.except) c.delete();
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
