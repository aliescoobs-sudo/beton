// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { erasePending, forgetAll, retryPendingErase } from './offline-store';
import {
  LEGACY_DB,
  PhotoListIncomplete,
  queuedPhotos,
  queuePhoto,
  reserveEpoch,
  withStoreLock,
  wipePhotos,
  type QueuedPhoto,
} from './photo-queue';

// T10c (R17-07, R17-08, R15B-03/04): the photo store across pages. Real photo-queue and offline-store code over a fake IndexedDB, with
// deterministic pauses and injected failures through the module's own seams (globalThis.__kayasPhotoHooks).
const local = new Map<string, string>();
type Hooks = { pause?: (p: string) => Promise<void> | void; fail?: (p: string) => boolean };
const setHooks = (h: Hooks | undefined) =>
  ((globalThis as { __kayasPhotoHooks?: Hooks }).__kayasPhotoHooks = h);
const gate = () => {
  let open!: () => void;
  const reached = (() => {
    let r!: () => void;
    const p = new Promise<void>((res) => (r = res));
    return { p, r };
  })();
  const p = new Promise<void>((res) => (open = res));
  return { wait: p, open, reached: reached.p, mark: reached.r };
};
const photo = (key: string, userId: string): QueuedPhoto => ({
  key,
  tripId: 't1',
  takenAt: '2026-11-07T08:00:00.000Z',
  blob: new Blob(['x']),
  userId,
});
const opened: IDBDatabase[] = [];
async function legacyDb(rows: { key: string; userId: string }[]): Promise<IDBDatabase> {
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
const putLegacy = (db: IDBDatabase, row: { key: string; userId: string }) =>
  new Promise<void>((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').put({ ...row, tripId: 't', takenAt: 'x', blob: new Blob(['x']) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
const legacyKeys = (db: IDBDatabase) =>
  new Promise<string[]>((resolve) => {
    const c = db.transaction('photos').objectStore('photos').getAllKeys();
    c.onsuccess = () => resolve(c.result as string[]);
  });
const keys = async () => (await queuedPhotos()).map((p) => p.key).sort();

beforeEach(async () => {
  local.clear();
  setHooks(undefined);
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  });
  vi.stubGlobal('caches', {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({ keys: async () => [], delete: async () => true }),
  });
  await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
  local.clear();
});
afterEach(() => {
  setHooks(undefined);
  for (const db of opened.splice(0)) db.close();
});

describe('R15B-03: one persistent epoch for every page', () => {
  it('stamps are strictly increasing, unique under concurrency, and do not depend on the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2001-01-01'));
    const a = await reserveEpoch();
    vi.setSystemTime(new Date('1990-01-01')); // the clock goes back
    const many = await Promise.all(Array.from({ length: 25 }, () => reserveEpoch()));
    vi.useRealTimers();
    expect(new Set(many).size).toBe(25);
    expect(Math.min(...many)).toBeGreaterThan(a);
    expect(await reserveEpoch()).toBeGreaterThan(Math.max(...many));
  });
});

describe('R17-07: the legacy migration against wipes and old pages', () => {
  it('a wipe that starts while the migration is paused after its snapshot waits for it, and nothing is put back afterwards', async () => {
    const old = await legacyDb([{ key: 'p1', userId: 'A' }]);
    const g = gate();
    setHooks({ pause: (p) => (p === 'snapshot' ? (g.mark(), g.wait) : undefined) });
    const listing = queuedPhotos().catch(() => []); // migration starts, pauses after the snapshot
    await g.reached;
    let wipeDone = false;
    const wipe = forgetAll({ only: 'A' }).then((r) => ((wipeDone = true), r));
    await new Promise((r) => setTimeout(r, 60));
    expect(wipeDone).toBe(false); // serialized behind the migration (the lock)
    g.open();
    await listing;
    const r = await wipe;
    old.close();
    await new Promise((res) => setTimeout(res, 50)); // R18-06: the browser runs the queued fence/deletion once the old page lets go; until then the former database is unknown
    expect(r.failed).toEqual([]);
    expect(await keys()).toEqual([]); // erased, and not resurrected by the migration that had its snapshot
  });

  it('without a working lock, a delayed copy still cannot put an erased photo back (the wipe’s tombstone)', async () => {
    vi.stubGlobal('navigator', { locks: { request: (_n: string, cb: () => Promise<unknown>) => cb() } }); // a lock that excludes nobody
    const old = await legacyDb([
      { key: 'gone', userId: 'A' },
      { key: 'kept', userId: 'B' },
    ]);
    const g = gate();
    setHooks({ pause: (p) => (p === 'copy' ? (g.mark(), g.wait) : undefined) });
    const migrating = queuedPhotos().catch(() => []);
    await g.reached; // snapshot taken, copy not committed
    setHooks(undefined);
    await wipePhotos({ only: 'A' }); // the wipe overtakes the copy
    g.open();
    await migrating;
    old.close();
    await new Promise((res) => setTimeout(res, 50)); // the queued fence/deletion runs once the old page lets go
    expect(await keys()).toEqual(['kept']);
  });

  it('an old page writing after the snapshot: its photo is never deleted by the migration, and is copied by the next round', async () => {
    const old = await legacyDb([{ key: 'first', userId: 'A' }]);
    const g = gate();
    setHooks({ pause: (p) => (p === 'snapshot' ? (g.mark(), g.wait) : undefined) });
    const migrating = queuedPhotos().catch(() => []);
    await g.reached;
    await putLegacy(old, { key: 'late', userId: 'A' }); // the old tab captures after the snapshot
    g.open();
    await migrating;
    setHooks(undefined);
    // the old page keeps its connection: the former database cannot be fenced or deleted, but nothing it holds was thrown away.
    // R18-06: and the list says it cannot see everything (the open is blocked): "at least these", never a complete-looking count.
    const err = await queuedPhotos().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoListIncomplete);
    const all = (err as PhotoListIncomplete).rows.map((p) => p.key).sort();
    expect(all).toContain('first');
    const stillThere = await legacyKeys(old);
    expect(stillThere.includes('late') || all.includes('late')).toBe(true);
    old.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await keys()).toEqual(['first', 'late']);
  });

  it('two wipes at once (a logout and an account switch) are serialized and both complete', async () => {
    await queuePhoto(photo('a', 'A'));
    await queuePhoto(photo('b', 'B'));
    const [x, y] = await Promise.all([forgetAll({ only: 'A' }), forgetAll({ except: 'B' })]);
    expect(x.complete && y.complete).toBe(true);
    expect(await keys()).toEqual(['b']);
  });

  it('the fallback lease excludes two holders (no Web Locks)', async () => {
    vi.stubGlobal('navigator', {});
    let inside = 0;
    let max = 0;
    const section = () =>
      withStoreLock(async () => {
        inside++;
        max = Math.max(max, inside);
        await new Promise((r) => setTimeout(r, 30));
        inside--;
      });
    await Promise.all([section(), section(), section()]);
    expect(max).toBe(1);
  });
});

describe('R17-08: failures are reported, kept pending and retried', () => {
  it.each(['erase-new', 'open-new'])(
    'an injected failure at %s: the wipe says incomplete, the erase stays pending, a retry finishes it',
    async (at) => {
      await queuePhoto(photo('a', 'A'));
      setHooks({ fail: (p) => p === at });
      const r = await forgetAll({ only: 'A' });
      expect(r.complete).toBe(false);
      expect(erasePending()).toBe(true);
      setHooks(undefined);
      expect(await keys()).toEqual(['a']); // not erased, and not claimed to be
      const retry = await retryPendingErase();
      expect(retry.complete).toBe(true);
      expect(erasePending()).toBe(false);
      expect(await keys()).toEqual([]);
    },
  );

  it('a retry keeps the ORIGINAL cutoff: a photo queued after the first wipe began survives the retry', async () => {
    await queuePhoto(photo('old', 'A'));
    setHooks({ fail: (p) => p === 'erase-new' });
    await forgetAll({ except: 'B' });
    setHooks(undefined);
    await queuePhoto(photo('new', 'C'));
    await retryPendingErase();
    expect(await keys()).toEqual(['new']);
  });

  it('unreadable stores make the list incomplete (an UNKNOWN count), never an empty one', async () => {
    await queuePhoto(photo('a', 'A'));
    setHooks({ fail: (p) => p === 'read-new' });
    const err = await queuedPhotos().catch((e) => e);
    expect(err).toBeInstanceOf(PhotoListIncomplete);
    setHooks({ fail: (p) => p === 'read-legacy' });
    const old = await legacyDb([{ key: 'l1', userId: 'A' }]);
    const err2 = await queuedPhotos().catch((e) => e);
    old.close();
    expect(err2).toBeInstanceOf(PhotoListIncomplete);
  });

  it('a migration that cannot copy deletes nothing and reports the wipe as incomplete', async () => {
    const old = await legacyDb([{ key: 'l1', userId: 'A' }]);
    setHooks({ fail: (p) => p === 'copy' });
    const r = await wipePhotos({ only: 'B' });
    expect(r.complete).toBe(false);
    expect(r.failed).toContain('migrate');
    setHooks(undefined);
    expect(await legacyKeys(old)).toEqual(['l1']); // untouched
    old.close();
  });
});
