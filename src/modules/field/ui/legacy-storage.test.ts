// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { forgetAll } from './offline-store';
import { LEGACY_DB, queuedPhotos, queuePhoto, wipePhotos } from './photo-queue';

// KAYAS rebrand: the photo database was renamed. A phone that used the former name must not keep any residue after a sign-out or a wipe.
const names = async () => (await indexedDB.databases()).map((d) => d.name);

async function createLegacyStore(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('photos', { keyPath: 'key' });
      store.put({ key: 'old', tripId: 't', takenAt: 'x', blob: new Blob(['x']), userId: 'A' });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

describe('legacy (BELGOBETON-named) browser storage is deleted by the wipe paths', () => {
  it('the new database is KAYAS-named and the legacy name is the former product name', async () => {
    await queuePhoto({ key: 'k', tripId: 't', takenAt: 'x', blob: new Blob(['x']), userId: 'A' });
    expect(await names()).toContain('kayas-field');
    expect(LEGACY_DB).toBe('belgobeton-field');
    await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
  });

  it('wipePhotos deletes the legacy database, even for a one-account scope', async () => {
    await createLegacyStore();
    expect(await names()).toContain(LEGACY_DB);
    await wipePhotos({ only: 'B' });
    expect(await names()).not.toContain(LEGACY_DB);
  });

  it('forgetAll (sign-out) deletes the legacy database and the caches/keys stay clean', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal('caches', {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({ keys: async () => [] }),
    });
    await createLegacyStore();
    await forgetAll('everything');
    expect(await names()).not.toContain(LEGACY_DB);
    expect(await queuedPhotos()).toEqual([]);
  });
});
