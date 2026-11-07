// Client only. The phone's sync, photo upload and sign-out, apart from React so that the WHOLE lifecycle can be tested with a stalled
// network and slow storage (R14-06). They share ONE session generation with the day controller:
//   - every piece of work starts under a guard (day-controller `openWork`) and commits only while that guard is alive;
//   - a sign-out FENCES first: no new read, sync or upload starts from then on, and work already on its way is aborted;
//   - the sign-out's own last send (the "drain") has an overall deadline: a stuck network never keeps the day on the screen;
//   - a sign-in opens a new generation: nothing started before it can commit into it.
import type { WorkGuard } from './day-controller';

export interface SessionDay {
  loadDay(guard?: WorkGuard | null): Promise<void>;
  refused(): void;
  signedOut(): void;
  signedIn(): void;
  openWork(kind: 'background' | 'drain'): WorkGuard | null;
  /** The session generation now (a sign-out operation belongs to the one it started in). */
  generation(): number;
  fence(): void;
  unfence(): void;
}

export interface QueuedPhotoRef {
  key: string;
  tripId: string;
  userId: string;
}

export interface SessionPorts<P extends QueuedPhotoRef> {
  day: SessionDay;
  /** POSTs the waiting taps. */
  postSync(signal: AbortSignal): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
  queueLength(): number;
  /** Commits the server's answer to the stored queue. Called only while the sync's session is alive. */
  applyOutcomes(json: unknown): void;
  listPhotos(): Promise<P[]>;
  sendPhoto(photo: P, signal: AbortSignal): Promise<'sent' | 'retry' | 'drop'>;
  dropPhoto(key: string): Promise<void>;
  owner(): string | null;
  ui: {
    setOnline(online: boolean): void;
    refusedPhoto(): void;
    photosWaiting(rest: P[]): void;
    /** The taps and photo counts are gone (after the sign-out). */
    clearWaiting(): void;
  };
  /** Asks the driver whether to sign out although `count` things are still waiting. */
  confirmPending(count: number): boolean;
  /** The server call of the sign-out. It must honour the signal (an aborted fetch's response is discarded by the browser). */
  logoutRequest(signal: AbortSignal): Promise<unknown>;
  /** Overall limit of the sign-out's last send (ms). */
  drainDeadlineMs: number;
  /** Overall limit of the logout request (ms): after it the request is aborted and a new sign-in may go on (R15A-01). */
  logoutDeadlineMs: number;
}

export function createFieldSession<P extends QueuedPhotoRef>(ports: SessionPorts<P>) {
  const day = ports.day;
  let syncRunning: Promise<void> | null = null;
  let flushRunning: Promise<void> | null = null;
  // R15A-01: a sign-out belongs to the generation that started it. A second press in the SAME generation joins the running one; a press in
  // a later generation (after a new sign-in) is a new operation, whatever became of an older one or of its server call.
  let activeSignOut: { gen: number; promise: Promise<void> } | null = null;
  // Every logout request still on its way. Each has its own abort and its own deadline; none of them can hold back another sign-out.
  const logoutTransports = new Set<Promise<void>>();

  async function runSync(guard: WorkGuard): Promise<void> {
    try {
      if (ports.queueLength() === 0) return;
      const res = await ports.postSync(guard.signal);
      if (!guard.alive()) return; // the session ended while the request was on its way: nothing of its answer is kept
      if (res.status === 401) return day.refused(); // the queue stays: it is sent after the next sign-in
      if (!res.ok) return;
      const body = await res.json();
      if (!guard.alive()) return;
      ports.applyOutcomes(body);
      ports.ui.setOnline(true);
      await day.loadDay(guard);
    } catch {
      if (guard.alive()) ports.ui.setOnline(false);
    } finally {
      guard.done();
    }
  }

  /** `kind`: a background sync is skipped while one runs; the sign-out's drain waits for it, then sends itself. */
  async function sync(kind: 'background' | 'drain' = 'background'): Promise<void> {
    if (kind === 'background') {
      if (syncRunning) return;
      const guard = day.openWork('background');
      if (!guard) return;
      const run = runSync(guard).finally(() => {
        if (syncRunning === run) syncRunning = null;
      });
      syncRunning = run;
      return run;
    }
    // The guard is taken BEFORE waiting: a drain that outlives its sign-out (deadline) belongs to a finished generation and sends nothing.
    const guard = day.openWork('drain');
    if (!guard) return;
    await syncRunning?.catch(() => undefined);
    if (!guard.alive()) return guard.done();
    const run = runSync(guard).finally(() => {
      if (syncRunning === run) syncRunning = null;
    });
    syncRunning = run;
    return run;
  }

  async function runFlush(guard: WorkGuard): Promise<void> {
    try {
      const mine = () => ports.owner();
      const all = (await ports.listPhotos().catch(() => [] as P[])).filter((p) => p.userId === mine());
      if (!guard.alive()) return;
      for (const p of all) {
        if (!guard.alive()) return; // nothing new is uploaded once the session is over or a sign-out has started
        const verdict = await ports.sendPhoto(p, guard.signal);
        if (!guard.alive()) return;
        if (verdict === 'retry') break;
        await ports.dropPhoto(p.key);
        if (!guard.alive()) return;
        if (verdict === 'drop') ports.ui.refusedPhoto();
      }
      const rest = (await ports.listPhotos().catch(() => [] as P[])).filter((p) => p.userId === mine());
      if (!guard.alive()) return;
      ports.ui.photosWaiting(rest);
      if (all.length > rest.length) await day.loadDay(guard);
    } catch {
      // an aborted upload: the photo stays queued
    } finally {
      guard.done();
    }
  }

  async function flushPhotos(kind: 'background' | 'drain' = 'background'): Promise<void> {
    if (kind === 'background') {
      if (flushRunning) return;
      const guard = day.openWork('background');
      if (!guard) return;
      const run = runFlush(guard).finally(() => {
        if (flushRunning === run) flushRunning = null;
      });
      flushRunning = run;
      return run;
    }
    const guard = day.openWork('drain');
    if (!guard) return;
    await flushRunning?.catch(() => undefined);
    if (!guard.alive()) return guard.done();
    const run = runFlush(guard).finally(() => {
      if (flushRunning === run) flushRunning = null;
    });
    flushRunning = run;
    return run;
  }

  /**
   * The sign-out. 1) fence: nothing new starts, work on its way is aborted. 2) a last send of what can still be sent, within the
   * overall deadline. 3) if things are still waiting, the driver is told. 4) the screen is cleared at once (a new generation), the
   * server call and the erasing follow on their own. The phone stays fenced until the next sign-in.
   */
  function signOut(): Promise<void> {
    if (activeSignOut && activeSignOut.gen === day.generation()) return activeSignOut.promise;
    const entry = { gen: day.generation(), promise: Promise.resolve() };
    activeSignOut = entry;
    entry.promise = runSignOut().finally(() => {
      if (activeSignOut === entry) activeSignOut = null;
    });
    return entry.promise;
  }

  async function runSignOut(): Promise<void> {
    day.fence();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), ports.drainDeadlineMs);
    });
    const drain = (async () => {
      await sync('drain');
      await flushPhotos('drain');
      return ports.listPhotos().catch(() => [] as P[]);
    })();
    const result = await Promise.race([drain, expired]);
    clearTimeout(timer);
    let photos: P[];
    if (result === 'expired') {
      // The deadline: whatever is still on its way is aborted; the sign-out goes on with what is known.
      drain.catch(() => undefined);
      photos = [];
    } else photos = result.filter((x) => x.userId === ports.owner());
    const waiting = ports.queueLength() + photos.length + (result === 'expired' ? 1 : 0);
    if (waiting > 0 && !ports.confirmPending(waiting)) {
      day.unfence();
      return;
    }
    day.signedOut();
    ports.ui.clearWaiting();
    await sendLogout();
  }

  /** The server call of one sign-out: its own abort, its own deadline. It never throws and it always settles. */
  function sendLogout(): Promise<void> {
    const ctl = new AbortController();
    const transport = new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        ctl.abort(); // the browser discards the response of an aborted request: it cannot apply a cookie after this point
        resolve();
      }, ports.logoutDeadlineMs);
      ports
        .logoutRequest(ctl.signal)
        .catch(() => null)
        .finally(() => {
          clearTimeout(deadline);
          resolve();
        });
    }).finally(() => void logoutTransports.delete(transport));
    logoutTransports.add(transport);
    return transport;
  }

  /**
   * Resolves when no logout request is on its way (each one is bounded by its deadline). The sign-in form waits for this BEFORE it
   * sends the login, so a late "delete the cookie" answer of an older logout can never land after a newer login's cookie.
   */
  async function logoutsSettled(): Promise<void> {
    while (logoutTransports.size > 0) await Promise.all([...logoutTransports]);
  }

  /** A successful sign-in: a new generation, then the first read and send. */
  async function signedIn(): Promise<void> {
    day.signedIn();
    await day.loadDay();
    await sync();
  }

  return { sync, flushPhotos, signOut, signedIn, logoutsSettled, isSigningOut: () => activeSignOut !== null };
}
