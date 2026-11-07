// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAll } from './offline-store';
import { queuedPhotos, queuePhoto, wipePhotos, type QueuedPhoto } from './photo-queue';

// R15A-03: storage-level. Real photo-queue and offline-store code over a fake IndexedDB, with Cache Storage held by hand.
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};
let cacheGate: Promise<void> | null = null;
const local = new Map<string, string>();

beforeEach(async () => {
  cacheGate = null;
  local.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  });
  vi.stubGlobal('caches', {
    // every Cache Storage call waits for the gate, as a slow device does
    keys: async () => {
      await cacheGate;
      return [];
    },
    delete: async () => true,
    open: async () => ({ keys: async () => [], delete: async () => true }),
  });
  await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
});

const photo = (key: string, userId: string): QueuedPhoto => ({
  key,
  tripId: 't1',
  takenAt: '2026-11-07T08:00:00.000Z',
  blob: new Blob(['x']),
  userId,
});
const keys = async () => (await queuedPhotos()).map((p) => p.key).sort();
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('a delayed wipe never erases what was queued after it began (R15A-03)', () => {
  it("A to B to C: C queues a photo while the older wipe (all but B) is stalled; C's photo survives, A's goes", async () => {
    await queuePhoto(photo('a-old', 'A'));
    await queuePhoto(photo('b-own', 'B'));
    const gate = deferred();
    cacheGate = gate.promise;
    const wipe = forgetAll({ except: 'B' }); // B reads the day on a phone that holds A's work; Cache Storage stalls
    await tick();
    await queuePhoto(photo('c-new', 'C')); // B signed out, C signed in and took a photo meanwhile
    gate.resolve();
    await wipe;
    expect(await keys()).toEqual(['b-own', 'c-new']);
  });

  it("A to A: A's photo queued after the sign-out wipe began survives it; the old one does not", async () => {
    await queuePhoto(photo('a-old', 'A'));
    const gate = deferred();
    cacheGate = gate.promise;
    const wipe = forgetAll({ only: 'A' });
    await tick();
    await queuePhoto(photo('a-new', 'A')); // A signed in again
    gate.resolve();
    await wipe;
    expect(await keys()).toEqual(['a-new']);
  });

  it('unknown owner: the whole-store wipe erases what existed and spares every later photo', async () => {
    await queuePhoto(photo('x-old', 'A'));
    await queuePhoto(photo('y-old', 'B'));
    const gate = deferred();
    cacheGate = gate.promise;
    const wipe = forgetAll('everything');
    await tick();
    await queuePhoto(photo('late-d', 'D'));
    gate.resolve();
    await wipe;
    expect(await keys()).toEqual(['late-d']);
  });

  it('a photo stored before the stamp existed counts as old and is wiped in scope', async () => {
    // simulates a row written by the previous version of the app (no seq)
    const raw = photo('legacy', 'A');
    await queuePhoto({ ...raw, seq: 0 });
    await forgetAll({ only: 'A' });
    expect(await keys()).toEqual([]);
  });

  it('a wipe in scope still erases the account it is aimed at and spares the others (no regression)', async () => {
    await queuePhoto(photo('a1', 'A'));
    await queuePhoto(photo('b1', 'B'));
    await forgetAll({ only: 'A' });
    expect(await keys()).toEqual(['b1']);
  });
});
