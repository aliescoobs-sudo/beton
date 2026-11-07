import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDayController, type DayPorts, type WipeScope } from './day-controller';
import { createFieldSession, type QueuedPhotoRef } from './field-session';
import { DAY_KEY, QUEUE_KEY } from './offline-store';

// R14-06: the WHOLE lifecycle of the phone (day controller + sync + photo upload + sign-out) with a stalled network and slow storage.
// The same objects the screen uses, with every asynchronous port held by hand.
interface TestDay {
  userId: string;
  label: string;
}
interface Photo extends QueuedPhotoRef {
  key: string;
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
/** Resolves to a rejection when the signal aborts, as fetch does. */
const stalls = <T>(signal: AbortSignal, honour = true) =>
  new Promise<T>((_, reject) => {
    if (honour) signal.addEventListener('abort', () => reject(new Error('aborted')));
  });

function rig(opts?: { honourAbort?: boolean; confirm?: boolean }) {
  const store = new Map<string, string>();
  let owner: string | null = 'u1';
  let queue: unknown[] = [{ key: 'tap-1' }];
  let photos: Photo[] = [];
  const log = {
    sessionReads: 0,
    syncPosts: 0,
    uploads: [] as string[],
    outcomesApplied: 0,
    confirms: [] as number[],
    logouts: 0,
    wipes: [] as WipeScope[],
    clearWaiting: 0,
  };
  const ui = { day: undefined as TestDay | null | undefined, session: 'in' as string };
  // each test overrides these
  const hooks = {
    session: async (): Promise<TestDay> => ({ userId: 'u1', label: 'day' }),
    post: (signal: AbortSignal): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }> =>
      Promise.resolve({ status: 200, ok: true, json: async () => ({ outcomes: [] }) }).then((r) => {
        void signal;
        return r;
      }),
    upload: (async () => 'sent') as (p: Photo, signal: AbortSignal) => Promise<'sent' | 'retry' | 'drop'>,
    forgetAll: async (): Promise<void> => undefined,
    listPhotos: async (): Promise<Photo[]> => photos.map((p) => ({ ...p })),
  };
  const dayPorts: DayPorts<TestDay> = {
    fetchSession: async () => {
      log.sessionReads++;
      const d = await hooks.session();
      return { status: 200, ok: true, json: async () => d };
    },
    now: () => NOW,
    local: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    forgetRead: async () => void store.delete(DAY_KEY),
    forgetAll: async (scope) => {
      log.wipes.push(scope);
      store.delete(DAY_KEY);
      store.delete(QUEUE_KEY);
      await hooks.forgetAll();
    },
    queuedPhotos: async () => hooks.listPhotos(),
    owner: { get: () => owner, set: (id) => void (owner = id) },
    queueNow: () => queue,
    ui: {
      setDay: (d) => void (ui.day = d),
      setSession: (s) => void (ui.session = s),
      setOnline: () => undefined,
      clearWaiting: () => void log.clearWaiting++,
    },
    readTimeoutMs: 10_000,
    isShown: () => true,
  };
  const controller = createDayController(dayPorts);
  const session = createFieldSession<Photo>({
    day: controller,
    postSync: (signal) => {
      log.syncPosts++;
      return hooks.post(signal);
    },
    queueLength: () => queue.length,
    applyOutcomes: () => {
      log.outcomesApplied++;
      queue = [];
    },
    listPhotos: () => hooks.listPhotos(),
    sendPhoto: (p, signal) => {
      log.uploads.push(p.key);
      return hooks.upload(p, signal);
    },
    dropPhoto: async (key) => void (photos = photos.filter((p) => p.key !== key)),
    owner: () => owner,
    ui: {
      setOnline: () => undefined,
      refusedPhoto: () => undefined,
      photosWaiting: () => undefined,
      clearWaiting: () => void log.clearWaiting++,
    },
    confirmPending: (count) => {
      log.confirms.push(count);
      return opts?.confirm ?? true;
    },
    logoutRequest: async () => void log.logouts++,
    drainDeadlineMs: 8_000,
  });
  return {
    controller,
    session,
    store,
    ui,
    log,
    hooks,
    setQueue: (q: unknown[]) => void (queue = q),
    setPhotos: (p: Photo[]) => void (photos = p),
    getPhotos: () => photos,
    setOwner: (o: string | null) => void (owner = o),
    getOwner: () => owner,
    queue: () => queue,
  };
}

afterEach(() => vi.useRealTimers());

describe('sign-out fences new work first (R14-06)', () => {
  it('a sync in flight on a stalled network is aborted at the fence; its late answer commits nothing and starts no read', async () => {
    const r = rig();
    const answer = deferred<{ status: number; ok: boolean; json(): Promise<unknown> }>();
    r.hooks.post = (signal) => {
      signal.addEventListener('abort', () => answer.reject(new Error('aborted')));
      return answer.promise;
    };
    const background = r.session.sync(); // the 20-second timer's sync, stuck
    await tick();
    expect(r.log.syncPosts).toBe(1);
    // the driver presses sign-out; the drain's own post is also stalled, and honours the abort at the deadline
    vi.useFakeTimers();
    r.hooks.post = (signal) => stalls(signal);
    const out = r.session.signOut();
    await vi.advanceTimersByTimeAsync(8_001);
    await out;
    vi.useRealTimers();
    await background;
    expect(r.log.sessionReads).toBe(0); // no read was started after the sign-out began
    expect(r.log.outcomesApplied).toBe(0);
    expect(r.ui.day).toBeNull();
    expect(r.ui.session).toBe('out');
    expect(r.log.logouts).toBe(1);
  });

  it('a sync whose answer arrives AFTER the fence (network does not honour abort) commits nothing and reads nothing', async () => {
    const r = rig({ confirm: true });
    const answer = deferred<{ status: number; ok: boolean; json(): Promise<unknown> }>();
    r.hooks.post = () => answer.promise; // ignores the signal: a stalled socket
    const background = r.session.sync();
    await tick();
    vi.useFakeTimers();
    const out = r.session.signOut(); // drain waits for the stuck sync, up to the deadline
    await vi.advanceTimersByTimeAsync(8_001);
    await out;
    vi.useRealTimers();
    answer.resolve({ status: 200, ok: true, json: async () => ({ outcomes: [] }) });
    await background;
    await tick();
    expect(r.log.outcomesApplied).toBe(0);
    expect(r.log.sessionReads).toBe(0);
    expect(r.ui.day).toBeNull();
    expect(r.log.confirms).toEqual([2]); // still waiting after the deadline: the driver was told (1 tap + the unknown rest)
  });

  it('the overall deadline: a stuck network and stuck IndexedDB never keep the screen beyond it', async () => {
    const r = rig();
    r.hooks.post = () => new Promise(() => undefined); // never answers, ignores the abort
    r.hooks.listPhotos = () => new Promise(() => undefined); // IndexedDB never answers
    vi.useFakeTimers();
    let finished = false;
    const out = r.session.signOut().then(() => void (finished = true));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await out;
    expect(finished).toBe(true);
    expect(r.ui.session).toBe('out');
    expect(r.ui.day).toBeNull();
  });

  it('a photo upload in flight is aborted at the fence and nothing new is uploaded or read afterwards', async () => {
    const r = rig();
    r.setQueue([]);
    r.setPhotos([
      { key: 'p1', tripId: 't1', userId: 'u1' },
      { key: 'p2', tripId: 't1', userId: 'u1' },
    ]);
    const first = deferred<'sent' | 'retry' | 'drop'>();
    r.hooks.upload = (_p, signal) => {
      signal.addEventListener('abort', () => first.reject(new Error('aborted')));
      return first.promise;
    };
    const flush = r.session.flushPhotos();
    await tick();
    expect(r.log.uploads).toEqual(['p1']);
    // sign-out while p1 is on its way: the second upload must never start, and the read after the uploads must never happen
    r.hooks.upload = async () => 'retry'; // the drain's own flush: the network is down
    vi.useFakeTimers();
    const out = r.session.signOut();
    await vi.advanceTimersByTimeAsync(8_001);
    await out;
    vi.useRealTimers();
    await flush;
    expect(r.log.uploads).not.toContain('p2');
    expect(r.log.sessionReads).toBe(0);
    expect(r.ui.day).toBeNull();
  });

  it('declining to sign out lifts the fence: background work resumes', async () => {
    const r = rig({ confirm: false });
    r.hooks.post = () => Promise.resolve({ status: 500, ok: false, json: async () => ({}) });
    await r.session.signOut();
    expect(r.log.confirms.length).toBe(1);
    expect(r.log.logouts).toBe(0);
    expect(r.controller.isFenced()).toBe(false);
    r.hooks.post = async () => ({ status: 200, ok: true, json: async () => ({ outcomes: [] }) });
    await r.session.sync();
    expect(r.log.outcomesApplied).toBe(1);
    expect(r.log.sessionReads).toBe(1);
  });

  it('while fenced, the day cannot be read and the timers start nothing', async () => {
    const r = rig({ confirm: true });
    r.setQueue([]);
    await r.session.signOut();
    r.setQueue([{ key: 'late-tap' }]);
    await r.controller.loadDay();
    await r.session.sync();
    await r.session.flushPhotos();
    expect(r.log.sessionReads).toBe(0);
    expect(r.log.syncPosts).toBe(0);
  });
});

describe('re-login after a sign-out (R14-06)', () => {
  it('an old sync answering after the new sign-in commits nothing into the new session', async () => {
    const r = rig();
    const answer = deferred<{ status: number; ok: boolean; json(): Promise<unknown> }>();
    r.hooks.post = () => answer.promise; // ignores abort
    const old = r.session.sync();
    await tick();
    vi.useFakeTimers();
    const out = r.session.signOut();
    await vi.advanceTimersByTimeAsync(8_001);
    await out;
    vi.useRealTimers();
    r.setOwner('u2');
    r.setQueue([{ key: 'u2-tap' }]);
    r.hooks.session = async () => ({ userId: 'u2', label: 'day-2' });
    r.hooks.post = async () => ({ status: 200, ok: true, json: async () => ({ outcomes: [] }) });
    await r.session.signedIn();
    const applied = r.log.outcomesApplied;
    answer.resolve({ status: 200, ok: true, json: async () => ({ outcomes: ['old'] }) });
    await old;
    await tick();
    expect(r.log.outcomesApplied).toBe(applied); // the old answer was not applied
    expect(r.ui.day).toEqual({ userId: 'u2', label: 'day-2' });
    expect(r.ui.session).toBe('in');
  });
});

describe('delayed IndexedDB and Cache Storage (R14-06)', () => {
  it("a stale wipe for another account does not clear the waiting counts of a newer session, and spares that account's photos", async () => {
    const r = rig();
    r.setOwner('u1');
    r.setPhotos([{ key: 'old-photo', tripId: 't1', userId: 'u1' }]);
    const wipe = deferred();
    r.hooks.forgetAll = () => wipe.promise; // Cache Storage / IndexedDB is slow
    r.hooks.session = async () => ({ userId: 'u2', label: 'day-2' }); // u2 signs in on the phone that holds u1's work
    const read = r.controller.loadDay();
    await tick();
    expect(r.log.wipes).toEqual([{ except: 'u2' }]); // owner-scoped: u2's own photos are never in the wipe
    // while the wipe is stuck, a sign-out and a new sign-in happen
    r.controller.signedOut();
    r.controller.signedIn();
    const clearedBefore = r.log.clearWaiting;
    wipe.resolve();
    await read;
    await tick();
    expect(r.log.clearWaiting).toBe(clearedBefore); // the stale wipe did not touch the queue shown
    expect(r.ui.day).toBeNull(); // and showed nothing
  });

  it('a sign-out wipe is limited to the signing-out account and runs on its own, without holding the screen', async () => {
    const r = rig();
    const idb = deferred();
    r.hooks.forgetAll = () => idb.promise;
    r.setQueue([]);
    await r.session.signOut();
    expect(r.log.wipes).toEqual([{ only: 'u1' }]);
    expect(r.ui.session).toBe('out'); // the screen did not wait for the stuck wipe
    idb.resolve();
  });

  it('an unknown owner is wiped entirely', () => {
    const r = rig();
    r.setOwner(null);
    r.controller.signedOut();
    expect(r.log.wipes).toEqual(['everything']);
  });
});
