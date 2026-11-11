// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { erasePending, erasePendingNotPersisted, forgetAll, retryPendingErase } from './offline-store';
import {
  LEGACY_DB,
  migrateLegacyPhotos,
  PhotoListIncomplete,
  queuedPhotos,
  queuePhoto,
  wipePhotos,
  type QueuedPhoto,
} from './photo-queue';

// R18-06: photo erasure against an expired lease, a newer snapshot across the erase commit, a failed legacy erase, a blocked legacy open, a
// storage that cannot hold the owed erase, and the reload. Real photo-queue / offline-store code over a fake IndexedDB, with the module's own seams.
const local = new Map<string, string>();
let localFails = false;
let removeFails = false;
type Hooks = { pause?: (p: string) => Promise<void> | void; fail?: (p: string) => boolean };
const setHooks = (h: Hooks | undefined) =>
  ((globalThis as { __kayasPhotoHooks?: Hooks }).__kayasPhotoHooks = h);
const gate = () => {
  let open!: () => void;
  let mark!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (mark = r));
  return { wait, open, reached, mark };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const photo = (key: string, userId: string): QueuedPhoto => ({
  key,
  tripId: 't1',
  takenAt: '2026-11-07T08:00:00.000Z',
  blob: new Blob(['x']),
  userId,
});
const opened: IDBDatabase[] = [];
function legacyDb(rows: { key: string; userId: string }[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore('photos', { keyPath: 'key' });
      for (const r of rows) s.put({ ...r, tripId: 't', takenAt: 'x', blob: new Blob(['x']) });
    };
    req.onsuccess = () => (opened.push(req.result), resolve(req.result));
    req.onerror = () => reject(req.error);
  });
}
const legacyKeys = (db: IDBDatabase) =>
  new Promise<string[]>((resolve) => {
    const c = db.transaction('photos').objectStore('photos').getAllKeys();
    c.onsuccess = () => resolve(c.result as string[]);
  });
const keys = async () => (await queuedPhotos()).map((p) => p.key).sort();
/** Edits the fallback lock record directly: what an expiry / a takeover by another page looks like. */
async function setLock(value: { owner: string; until: number } | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('kayas-field', 2);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readwrite');
      if (value) tx.objectStore('meta').put(value, 'lock');
      else tx.objectStore('meta').delete('lock');
      tx.oncomplete = () => (db.close(), resolve());
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  local.clear();
  localFails = false;
  removeFails = false;
  setHooks(undefined);
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (localFails) throw new Error('QuotaExceededError');
      local.set(k, v);
    },
    removeItem: (k: string) => {
      if (removeFails) throw new Error('SecurityError');
      local.delete(k);
    },
  });
  vi.stubGlobal('caches', {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({ keys: async () => [], delete: async () => true }),
  });
  vi.stubGlobal('navigator', {}); // no Web Locks: the fallback LEASE is what excludes (and what can expire)
  await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
  await retryPendingErase().catch(() => undefined);
  local.clear();
});
afterEach(() => {
  setHooks(undefined);
  for (const db of opened.splice(0)) db.close();
});

describe('R18-06: the lease is validated inside the erase transaction', () => {
  it('a wipe whose lease expired after it reserved its epoch does NOT commit; it reports incomplete and a retry erases everything, copied legacy row included', async () => {
    const old = await legacyDb([{ key: 'legacy-A', userId: 'A' }]);
    await queuePhoto(photo('new-A', 'A'));
    const g = gate();
    setHooks({ pause: (p) => (p === 'erase-new' ? (g.mark(), g.wait) : undefined) });
    const wipe = forgetAll({ only: 'A' });
    await g.reached; // the wipe holds the lease and has its epoch; its erase has not committed
    await setLock({ owner: 'another-page', until: Date.now() + 60_000 }); // the lease expired and another page took it
    setHooks(undefined);
    g.open();
    const r = await wipe;
    expect(r.complete).toBe(false);
    expect(r.failed).toContain('new-store');
    expect(erasePending()).toBe(true);
    // the stale erase committed NOTHING: the photo is still there (and said not to be erased)
    await setLock(null);
    old.close();
    await sleep(30);
    expect(await keys()).toContain('new-A');
    const retry = await retryPendingErase();
    expect(retry.complete).toBe(true);
    expect(await keys()).toEqual([]); // the new photo and the migrated legacy one are both gone
  });
});

describe('R18-06: a newer snapshot paused across the erase commit', () => {
  it('a migration whose snapshot began after the wipe reserved its epoch but before it committed cannot copy the erased photo back', async () => {
    // a lock that excludes nobody, so the wipe and the migration really overlap
    vi.stubGlobal('navigator', { locks: { request: (_n: string, cb: () => Promise<unknown>) => cb() } });
    const old = await legacyDb([
      { key: 'gone', userId: 'A' },
      { key: 'kept', userId: 'B' },
    ]);
    const wipeGate = gate();
    const copyGate = gate();
    setHooks({
      pause: (p) => {
        if (p === 'erase-new') return (wipeGate.mark(), wipeGate.wait);
        if (p === 'copy') return (copyGate.mark(), copyGate.wait);
        return undefined;
      },
    });
    // the wipe has its epoch and has migrated nothing yet (its own migration is the one that pauses at 'copy' first), so order the two explicitly:
    const migration = queuedPhotos().catch(() => []); // snapshot taken (epoch E_s), paused before the copy
    await copyGate.reached;
    const wipe = wipePhotos({ only: 'A' }); // reserves an epoch AFTER E_s; its own migration step would also copy... keep it out of the way:
    await sleep(30);
    copyGate.open(); // the first migration copies now (the wipe has not erased yet)
    await migration;
    await wipeGate.reached;
    wipeGate.open();
    const r = await wipe;
    old.close();
    await sleep(60);
    setHooks(undefined);
    expect(r.failed).toEqual([]);
    expect(await keys()).toEqual(['kept']); // 'gone' was erased on purpose and is not back
  });

  it("the review's ordering: a second page's snapshot is taken AFTER the wipe's epoch and its copy commits AFTER the wipe's erase — the erased row is not copied back", async () => {
    // a lock that excludes nobody, so the wipe and the second page's migration really overlap
    vi.stubGlobal('navigator', { locks: { request: (_n: string, cb: () => Promise<unknown>) => cb() } });
    const old = await legacyDb([{ key: 'gone', userId: 'A' }]);
    const eraseGate = gate();
    const copyGate = gate();
    let copies = 0;
    setHooks({
      pause: (p) => {
        if (p === 'erase-new') return (eraseGate.mark(), eraseGate.wait); // after the wipe reserved its epoch, before its erase commits
        if (p === 'copy' && ++copies === 2) return (copyGate.mark(), copyGate.wait); // the SECOND copy: after its snapshot, before its commit
        return undefined;
      },
      fail: (p) => p === 'copy' && copies === 1, // the wipe's own first step cannot move the former rows (so they are still there)
    });
    const wipe = wipePhotos({ only: 'A' });
    await eraseGate.reached;
    const migration = migrateLegacyPhotos().catch(() => 'error'); // another page: its snapshot (rows included) is later than the wipe's epoch
    await copyGate.reached;
    eraseGate.open(); // the wipe commits its erase and tombstone, erases the former row, and closes the tombstone
    await wipe;
    expect(await legacyKeys(old)).toEqual([]);
    copyGate.open(); // the late copy, built from the earlier snapshot, now tries to commit
    await migration;
    setHooks(undefined);
    old.close();
    await sleep(60);
    expect(await keys()).toEqual([]); // before the fix: ['gone'] — the tombstone's epoch (reservation) was not after the snapshot, so it was ignored
  });
});

describe('R18-06: a failed legacy erase leaves an OPEN tombstone', () => {
  it('a legacy row that survived a failed erase is not copied back by a later migration, and is taken out of the former database', async () => {
    const old = await legacyDb([{ key: 'left-behind', userId: 'A' }]);
    setHooks({ fail: (p) => p === 'copy' || p === 'erase-legacy' }); // the wipe cannot move it, and cannot erase it
    const r = await wipePhotos({ only: 'A' });
    expect(r.complete).toBe(false);
    expect(await legacyKeys(old)).toEqual(['left-behind']); // still in the former database
    setHooks(undefined);
    old.close();
    await sleep(30);
    // a later page lists the photos (and so migrates): the covering tombstone is still in force for the former rows
    expect(await keys()).toEqual([]);
  });

  it('the tombstone cap does not drop an open tombstone', async () => {
    const old = await legacyDb([{ key: 'left-behind', userId: 'A' }]);
    setHooks({ fail: (p) => p === 'copy' || p === 'erase-legacy' });
    await wipePhotos({ only: 'A' });
    setHooks(undefined);
    for (let i = 0; i < 60; i++) await wipePhotos({ only: `nobody-${i}` }, 0); // 60 further wipes: far above the cap of 50
    old.close();
    await sleep(30);
    expect(await keys()).toEqual([]); // the first wipe's tombstone is still there
  });
});

describe('R18-06: a blocked open of the former database is unknown, not empty', () => {
  it('an old page holds the former database with a deletion queued behind it (not by this module): the list is INCOMPLETE after the open times out', async () => {
    const old = await legacyDb([{ key: 'unseen', userId: 'A' }]);
    await queuePhoto(photo('mine', 'A'));
    // a deletion requested outside this module is queued behind the old page: any open waits behind it
    indexedDB.deleteDatabase(LEGACY_DB);
    const err = await queuedPhotos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoListIncomplete);
    expect((err as PhotoListIncomplete).rows.map((p) => p.key)).toEqual(['mine']); // "at least these", never "this is all"
    old.close();
    await sleep(60);
    expect(await keys()).toEqual(['mine']); // once the browser ran the deletion, the list is complete again
  }, 15_000);
});

describe('R18-06: the owed erase survives a storage that cannot hold it, and the reload', () => {
  it('localStorage refusing the write AND the durable copy failing (R19-06: the debt has a second place now): kept in memory, retried, and the failure is SURFACED', async () => {
    await queuePhoto(photo('a', 'A'));
    localFails = true;
    setHooks({ fail: (p) => p === 'erase-new' || p === 'owed-write' });
    const r = await forgetAll({ only: 'A' });
    expect(r.complete).toBe(false);
    expect(r.persistFailed).toBe(true);
    expect(erasePendingNotPersisted()).toBe(true);
    expect(erasePending()).toBe(true); // still owed, from memory
    setHooks(undefined);
    expect((await retryPendingErase()).complete).toBe(true);
    expect(erasePending()).toBe(false);
    expect(erasePendingNotPersisted()).toBe(false);
    expect(await keys()).toEqual([]);
  });

  it('with a working localStorage the owed erase survives a reload (a fresh module instance) and is finished there', async () => {
    await queuePhoto(photo('a', 'A'));
    setHooks({ fail: (p) => p === 'erase-new' });
    expect((await forgetAll({ only: 'A' })).complete).toBe(false);
    setHooks(undefined);
    vi.resetModules(); // the page is reloaded: no memory of the earlier instance, only what the phone's storage holds
    const fresh = await import('./offline-store');
    expect(fresh.erasePending()).toBe(true);
    expect((await fresh.retryPendingErase()).complete).toBe(true);
    expect(fresh.erasePending()).toBe(false);
    expect((await (await import('./photo-queue')).queuedPhotos()).map((p) => p.key)).toEqual([]);
  });
});

describe('R19-06: the owed erase has a second, durable place, and a storage fault never hides the debt', () => {
  it('localStorage refusing EVERYTHING (writes and removals) and the erase aborted: the debt is held in IndexedDB, survives a real reload and is finished there', async () => {
    await queuePhoto(photo('a', 'A'));
    localFails = true;
    setHooks({ fail: (p) => p === 'erase-new' });
    const r = await forgetAll({ only: 'A' });
    expect(r.complete).toBe(false);
    expect(r.persistFailed).toBe(false); // the durable copy took it
    setHooks(undefined);
    vi.resetModules(); // the page is reloaded: no memory, and localStorage still refuses
    const fresh = await import('./offline-store');
    expect(fresh.erasePending()).toBe(false); // nothing is known until the durable copy is read...
    await fresh.hydrateOwed();
    expect(fresh.erasePending()).toBe(true); // ...and then the debt is back
    expect((await fresh.retryPendingErase()).complete).toBe(true);
    expect(fresh.erasePending()).toBe(false);
    expect((await (await import('./photo-queue')).queuedPhotos()).map((p) => p.key)).toEqual([]);
    // and once settled, a further reload finds no debt
    vi.resetModules();
    const again = await import('./offline-store');
    await again.hydrateOwed();
    expect(again.erasePending()).toBe(false);
  });

  it('neither place can hold the debt: the result says so (the screen shows the notice), the debt stays in memory and is retried', async () => {
    await queuePhoto(photo('a', 'A'));
    localFails = true;
    setHooks({ fail: (p) => p === 'erase-new' || p === 'owed-write' });
    const r = await forgetAll({ only: 'A' });
    expect(r.complete).toBe(false);
    expect(r.persistFailed).toBe(true);
    expect(erasePendingNotPersisted()).toBe(true);
    setHooks(undefined);
    expect((await retryPendingErase()).complete).toBe(true);
    expect(erasePendingNotPersisted()).toBe(false);
  });

  it('a localStorage that THROWS on removal does not stop the erase of the other stores, and is reported as incomplete', async () => {
    await queuePhoto(photo('a', 'A'));
    removeFails = true;
    const r = await forgetAll({ only: 'A' });
    expect(await keys()).toEqual([]); // the photos were erased although the removals threw
    expect(r.complete).toBe(false);
    expect(r.failed).toContain('local-storage');
    removeFails = false;
    expect((await retryPendingErase()).complete).toBe(true);
  });
});
