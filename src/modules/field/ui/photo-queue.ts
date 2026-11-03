// Client only. The photos of signed BLs wait in the phone's IndexedDB until the server has them (a photo is too big for the
// localStorage queue of the taps). Nothing here is trusted by the server: it checks type, bytes, rotation and time again.
import { fitWithin, photoVerdict, type PhotoVerdict } from '../domain/photo';

export interface QueuedPhoto {
  key: string;
  tripId: string;
  takenAt: string;
  blob: Blob;
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

export async function sendPhoto(p: QueuedPhoto): Promise<PhotoVerdict> {
  const body = new FormData();
  body.set('tripId', p.tripId);
  body.set('key', p.key);
  body.set('takenAt', p.takenAt);
  body.set('photo', new File([p.blob], 'bl.jpg', { type: p.blob.type || 'image/jpeg' }));
  try {
    const res = await fetch('/api/field/bl-photo', { method: 'POST', body });
    const error = res.ok
      ? undefined
      : ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    return photoVerdict(res.status, error);
  } catch {
    return 'retry';
  }
}
