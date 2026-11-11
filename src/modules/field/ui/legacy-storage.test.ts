// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { forgetAll } from './offline-store';
import {
  deleteLegacyPhotoStore,
  LEGACY_DB,
  legacyCleanupPending,
  PhotoListIncomplete,
  queuedPhotos,
  queuePhoto,
  wipePhotos,
} from './photo-queue';

// KAYAS rebrand: the photo database was renamed. A phone that used the former name must not keep any residue after a sign-out or a wipe.
const names = async () => (await indexedDB.databases()).map((d) => d.name);
/**
 * R18-06: while an old page holds the former database (a deletion or fence queued behind it), what it holds cannot be read: the list is INCOMPLETE
 * (a count of "at least these"), never presented as complete. Returns the rows that could be read.
 */
async function incompleteRows(): Promise<string[]> {
  const err = await queuedPhotos().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PhotoListIncomplete);
  return (err as PhotoListIncomplete).rows.map((p) => p.key);
}

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

// R16-02: a deletion that is blocked or failed is never reported as done; the unsent photos of the former database are migrated, counted,
// and never lost by a blocked deletion.
describe('R16-02: legacy cleanup outcome is explicit', () => {
  const store = new Map<string, string>();
  const stubStorage = () =>
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  const stubCaches = () =>
    vi.stubGlobal('caches', {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({ keys: async () => [] }),
    });
  /** An old page: it opens the former database and keeps the connection open, with no versionchange handler (the former code never had one). */
  async function oldPage(rows: { key: string; userId: string }[]): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore('photos', { keyPath: 'key' });
        for (const r of rows) s.put({ ...r, tripId: 't', takenAt: 'x', blob: new Blob(['x']) });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const reset = async () => {
    store.clear();
    stubStorage();
    stubCaches();
    await wipePhotos('everything', Number.MAX_SAFE_INTEGER).catch(() => undefined);
  };

  const settled = async () => {
    for (let k = 0; k < 50 && ((await names()).includes(LEGACY_DB) || legacyCleanupPending()); k++)
      await new Promise((r) => setTimeout(r, 20));
  };

  it('a deletion that is blocked is reported as blocked, never as deleted, and keeps the pending state', async () => {
    await reset();
    const old = await oldPage([]);
    expect(await deleteLegacyPhotoStore()).toBe('blocked');
    expect(legacyCleanupPending()).toBe(true);
    expect(await names()).toContain(LEGACY_DB);
    old.close();
    await settled(); // the browser finishes the queued deletion once the old page is closed
    expect(legacyCleanupPending()).toBe(false);
    expect(await names()).not.toContain(LEGACY_DB);
  });

  it('a blocked deletion never loses an unsent photo: it is copied first, counted, and the cleanup completes when the old page closes', async () => {
    await reset();
    const old = await oldPage([{ key: 'p1', userId: 'A' }]);
    const listed = await incompleteRows(); // copy, then the deletion is asked: blocked, so the former database is unknown (not empty)
    expect(listed).toEqual(['p1']);
    expect(legacyCleanupPending()).toBe(true);
    expect(await names()).toContain(LEGACY_DB);
    // the former database holds no photo while its deletion waits (the copy is committed, then the rows are taken out)
    const count = await new Promise<number>((resolve) => {
      const c = old.transaction('photos').objectStore('photos').count();
      c.onsuccess = () => resolve(c.result);
    });
    expect(count).toBe(0);
    expect(await incompleteRows()).toEqual(['p1']); // still counted, not doubled, and still flagged as possibly more
    old.close();
    await settled();
    expect(await names()).not.toContain(LEGACY_DB);
    expect(legacyCleanupPending()).toBe(false);
    expect((await queuedPhotos()).map((p) => p.key)).toEqual(['p1']); // migrated, not lost
    await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
  });

  it("a wipe of one account while an old page holds the database: its rows are erased, another account's are kept, the state stays pending", async () => {
    await reset();
    const old = await oldPage([
      { key: 'mine', userId: 'A' },
      { key: 'theirs', userId: 'B' },
    ]);
    const result = await wipePhotos({ only: 'A' });
    expect(result.legacy).toBe('blocked');
    expect(legacyCleanupPending()).toBe(true);
    expect(await names()).toContain(LEGACY_DB);
    expect(await incompleteRows()).toEqual(['theirs']);
    old.close();
    await settled();
    expect(await names()).not.toContain(LEGACY_DB);
    expect((await queuedPhotos()).map((p) => p.key)).toEqual(['theirs']);
    await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
  });

  it('forgetAll reports a pending cleanup instead of success', async () => {
    await reset();
    const old = await oldPage([{ key: 'p1', userId: 'A' }]);
    expect((await forgetAll('everything')).legacyCleanupPending).toBe(true);
    old.close();
    await settled();
    expect((await forgetAll('everything')).legacyCleanupPending).toBe(false);
    expect(await names()).not.toContain(LEGACY_DB);
  });

  it("the application's own connections close on versionchange, so they never block a deletion", async () => {
    await reset();
    await queuePhoto({ key: 'k', tripId: 't', takenAt: 'x', blob: new Blob(['x']), userId: 'A' });
    await queuedPhotos();
    const outcome = await new Promise<string>((resolve) => {
      const req = indexedDB.deleteDatabase('kayas-field');
      req.onblocked = () => resolve('blocked');
      req.onsuccess = () => resolve('deleted');
      req.onerror = () => resolve('error');
    });
    expect(outcome).toBe('deleted');
  });
});
