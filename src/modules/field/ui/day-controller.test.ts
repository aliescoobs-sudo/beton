import { describe, expect, it } from 'vitest';
import { wrapDay } from '../domain/offline';
import { createDayController, type DayPorts } from './day-controller';
import { DAY_KEY, QUEUE_KEY } from './offline-store';

// R13-03: the ordering of the phone's reading, refusal and expiry with SLOW storage. Every local asynchronous step (IndexedDB photos,
// Cache Storage) is held by hand and released after the interleaving under test.
interface TestDay {
  userId: string;
  label: string;
}
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const NOW = 1_800_000_000_000;

function rig(opts?: {
  photos?: () => Promise<{ userId: string }[]>;
  forgetRead?: () => Promise<void>;
  forgetAll?: () => Promise<void>;
  fetchSession?: DayPorts<TestDay>['fetchSession'];
}) {
  const store = new Map<string, string>();
  const ui = {
    day: undefined as TestDay | null | undefined,
    session: 'unknown' as string,
    online: true,
    waitingCleared: 0,
  };
  let owner: string | null = null;
  const caches: string[] = ['api-cache']; // stands for Cache Storage: emptied only when the cleanup finishes
  const calls = { fetch: 0, forgetRead: 0, forgetAll: 0 };
  const respond = (day: TestDay, status = 200) => ({
    status,
    ok: status === 200,
    json: async () => day,
  });
  const ports: DayPorts<TestDay> = {
    fetchSession:
      opts?.fetchSession ??
      (async () => {
        calls.fetch++;
        return respond({ userId: 'u1', label: 'day-1' });
      }),
    now: () => NOW,
    local: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    forgetRead: async () => {
      calls.forgetRead++;
      store.delete(DAY_KEY); // synchronous part, as in the real store
      await (opts?.forgetRead?.() ?? Promise.resolve());
      caches.length = 0;
    },
    forgetAll: async () => {
      calls.forgetAll++;
      store.delete(DAY_KEY);
      store.delete(QUEUE_KEY);
      await (opts?.forgetAll?.() ?? Promise.resolve());
      caches.length = 0;
    },
    queuedPhotos: opts?.photos ?? (async () => []),
    owner: { get: () => owner, set: (id) => void (owner = id) },
    queueNow: () => [],
    ui: {
      setDay: (d) => void (ui.day = d),
      setSession: (s) => void (ui.session = s),
      setOnline: (o) => void (ui.online = o),
      clearWaiting: () => void ui.waitingCleared++,
    },
    readTimeoutMs: 10_000,
    isShown: () => true,
  };
  return {
    ports,
    controller: createDayController(ports),
    store,
    ui,
    calls,
    caches,
    owner: () => owner,
    respond,
  };
}
const staleStored = () => JSON.stringify(wrapDay('u1', { userId: 'u1', label: 'old' }, NOW - 19 * 3_600_000)); // past the 18 h limit

describe('what is shown is cleared at once; storage cleanup is independent (R13-03)', () => {
  it('a refusal empties the screen before Cache Storage has finished, and the screen never waits for it', () => {
    const cache = deferred();
    const r = rig({ forgetRead: () => cache.promise });
    r.ui.day = { userId: 'u1', label: 'shown' };
    r.ui.session = 'in';
    r.controller.refused(); // synchronous: nothing is awaited
    expect(r.ui.day).toBeNull();
    expect(r.ui.session).toBe('out');
    expect(r.caches).toEqual(['api-cache']); // the cache wipe is still pending
    cache.resolve();
  });
  it('an expired day leaves the screen at once, even with Cache Storage stuck, and the next read is not held back by it', async () => {
    const cache = deferred();
    const r = rig({
      forgetRead: () => cache.promise,
      fetchSession: async () => ({ status: 401, ok: false, json: async () => ({}) }),
    });
    r.store.set(DAY_KEY, staleStored());
    r.ui.day = { userId: 'u1', label: 'old' };
    r.ui.session = 'in';
    const rechecked = r.controller.recheck();
    expect(r.ui.day).toBeNull(); // before any await
    expect(r.ui.session).toBe('unknown');
    await rechecked; // the read (a refusal here) completes while Cache Storage is still stuck
    expect(r.ui.session).toBe('out');
    expect(r.caches).toEqual(['api-cache']);
    cache.resolve();
    await tick();
    expect(r.caches).toEqual([]);
  });
  it('a sign-out empties the screen before the cleanup, and forgets the owner', () => {
    const idb = deferred();
    const r = rig({ forgetAll: () => idb.promise });
    r.ui.day = { userId: 'u1', label: 'shown' };
    r.ui.session = 'in';
    r.controller.signedOut();
    expect(r.ui.day).toBeNull();
    expect(r.ui.session).toBe('out');
    expect(r.owner()).toBeNull();
    expect(r.calls.forgetAll).toBe(1);
    idb.resolve();
  });
  it('a failing cleanup neither throws nor blocks the screen', async () => {
    const r = rig({ forgetRead: () => Promise.reject(new Error('quota')) });
    r.ui.session = 'in';
    r.controller.refused();
    await tick();
    expect(r.ui.session).toBe('out');
  });
});

describe('an older read resuming after a newer refusal or sign-out changes nothing (R13-03)', () => {
  it('suspended in the IndexedDB photo read, then a refusal: it does not repopulate the screen, the stored day or the owner', async () => {
    const photos = deferred<{ userId: string }[]>();
    const r = rig({ photos: () => photos.promise });
    const reading = r.controller.loadDay();
    await tick(); // the read is now waiting on IndexedDB
    r.controller.refused();
    photos.resolve([]);
    await reading;
    expect(r.ui.day).toBeNull();
    expect(r.ui.session).toBe('out');
    expect(r.store.get(DAY_KEY)).toBeUndefined();
    expect(r.store.get(QUEUE_KEY)).toBeUndefined();
    expect(r.owner()).toBeNull();
  });
  it('suspended in the wipe for another account (forgetAll), then a sign-out: the wipe is finished but nothing is shown or stored', async () => {
    const idb = deferred();
    const r = rig({
      photos: async () => [{ userId: 'someone-else' }],
      forgetAll: () => idb.promise,
    });
    const reading = r.controller.loadDay();
    await tick();
    expect(r.calls.forgetAll).toBe(1);
    r.controller.signedOut();
    idb.resolve();
    await reading;
    expect(r.ui.day).toBeNull();
    expect(r.ui.session).toBe('out');
    expect(r.store.get(DAY_KEY)).toBeUndefined();
    expect(r.owner()).toBeNull();
  });
  it('suspended while the answer is decoded (json), then a refusal', async () => {
    const body = deferred<TestDay>();
    const r = rig({
      fetchSession: async () => ({ status: 200, ok: true, json: () => body.promise }),
    });
    const reading = r.controller.loadDay();
    await tick();
    r.controller.refused();
    body.resolve({ userId: 'u1', label: 'late' });
    await reading;
    expect(r.ui.day).toBeNull();
    expect(r.store.get(DAY_KEY)).toBeUndefined();
  });
  it('an older read finishing after a newer one does not overwrite it', async () => {
    const first = deferred<TestDay>();
    let n = 0;
    const r = rig({
      fetchSession: async () => {
        n++;
        return n === 1
          ? { status: 200, ok: true, json: () => first.promise }
          : { status: 200, ok: true, json: async () => ({ userId: 'u1', label: 'newer' }) };
      },
    });
    const older = r.controller.loadDay();
    await tick();
    await r.controller.loadDay();
    expect(r.ui.day?.label).toBe('newer');
    first.resolve({ userId: 'u1', label: 'older' });
    await older;
    expect(r.ui.day?.label).toBe('newer');
    expect(JSON.parse(r.store.get(DAY_KEY)!).day.label).toBe('newer');
  });
  it('a delayed refusal cleanup does not erase the day a newer sign-in has stored since', async () => {
    const cache = deferred();
    const r = rig({ forgetRead: () => cache.promise });
    r.controller.refused(); // cleanup stuck in Cache Storage
    await r.controller.loadDay(); // the account signed in again: a new day is on screen and stored
    expect(r.ui.day?.label).toBe('day-1');
    cache.resolve();
    await tick();
    expect(r.ui.day?.label).toBe('day-1');
    expect(r.store.get(DAY_KEY)).toBeDefined();
  });
  it('a read that fails after a refusal says nothing about the present (no offline day is brought back)', async () => {
    const net = deferred<never>();
    const r = rig({ fetchSession: () => net.promise });
    r.store.set(DAY_KEY, JSON.stringify(wrapDay('u1', { userId: 'u1', label: 'kept' }, NOW - 1000)));
    const reading = r.controller.loadDay();
    await tick();
    r.controller.refused(); // also erases the stored day
    net.reject(new Error('network'));
    await reading;
    expect(r.ui.day).toBeNull();
    expect(r.ui.session).toBe('out');
  });
});
