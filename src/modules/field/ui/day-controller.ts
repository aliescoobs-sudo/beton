// Client only. The phone's reading of the day, its refusal and its expiry (R11-06, R12-04, R13-03), apart from React so that the
// ordering rules can be tested with slow storage. Three rules, in this order of importance:
//   1. WHAT IS SHOWN is cleared synchronously at a refusal, an expiry or a sign-out: before any await, whatever storage or the network do.
//   2. STORAGE CLEANUP (local storage, IndexedDB photos, Cache Storage) runs on its own: the screen never waits for it, and a failing or
//      slow cleanup never blocks the next read.
//   3. EVERY await is followed by an epoch check before anything is COMMITTED (the screen, the owner, the stored day, the stored queue).
//      A read that is overtaken by a refusal, a sign-out or a newer read changes nothing. A wipe of another account's data that is already
//      running is completed, but it is owner-scoped, and a wipe that is overtaken while it waited changes nothing more (R14-06).
//   4. (R14-06) ONE SESSION GENERATION is shared by the reads, the syncs, the photo uploads and the wipes. A sign-out FENCES first: no new
//      read, sync or upload starts from that moment, and work that is already on its way is aborted. Work carries the guard it was started
//      under and commits only while that guard is alive.
import { judgeDay, mustWipeForAccount, readStoredDay, wrapDay } from '../domain/offline';
import { DAY_KEY as DAY_STORAGE_KEY, QUEUE_KEY as QUEUE_STORAGE_KEY } from './offline-store';

/** Whose photos a wipe may erase: those of one account, all but one account's, or (an unknown owner) all of them. */
export type WipeScope = { only: string } | { except: string } | 'everything';

/** A piece of background work (a sync, an upload, a read) and the session generation it was started under. */
export interface WorkGuard {
  /** False once the session is over (sign-out, refusal, new sign-in) or, for background work, once a sign-out has fenced. */
  alive(): boolean;
  /** Aborted at the same moment: an in-flight request stops with the session. */
  signal: AbortSignal;
  /** Called when the work is finished, whatever happened. */
  done(): void;
}

/** One sign-out operation (R15A-02): the only source of guards for the sign-out's own stages. */
export interface SignOutOp {
  alive(): boolean;
  /** Terminal: the operation opens no more guards and the ones it opened are aborted. Does not unfence. */
  end(): void;
  /** The driver stays: the operation ends and the fence is lifted (unless a newer session has begun). */
  cancel(): void;
  openDrain(): WorkGuard | null;
}

export interface DayPorts<D extends { userId: string }> {
  /**
   * The session read; aborted by the signal. `conditional` (T9, the live refresh): send the tag of the day this phone shows, so that an unchanged
   * day is answered 304 with no body. The port forgets the tag whenever the day is cleared.
   */
  fetchSession(
    signal: AbortSignal,
    conditional?: boolean,
  ): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
  now(): number;
  local: { get(key: string): string | null; set(key: string, value: string): void };
  /** Erase what names a client (the stored day, the caches); the queued work stays. */
  forgetRead(): Promise<void>;
  /** Erase the phone's local work: day, caches, queue, photos. The photos are erased within the scope only (R14-06). */
  /** Resolves with `{ complete: false }` when something was NOT erased (T10c): the controller keeps it visible and retryable. */
  forgetAll(scope: WipeScope): Promise<unknown>;
  /** Rejects with the rows it could read when some photos are unreadable (their number is then unknown). */
  queuedPhotos(): Promise<{ userId: string }[]>;
  owner: { get(): string | null; set(id: string | null): void };
  /** The taps waiting to be sent, as they are now (for the stored copy). */
  queueNow(): unknown;
  ui: {
    setDay(day: D | null): void;
    /** T10c: an erase of the phone's local data is not proven finished (true), or is (false). Never claims an erasure that did not happen. */
    setEraseIncomplete?(incomplete: boolean): void;
    /** R19-06: the debt of an erase could not be written to ANY durable place of the phone: a reload would forget it. The screen says so. */
    setEraseNotPersisted?(notPersisted: boolean): void;
    setSession(session: 'unknown' | 'out' | 'in'): void;
    setOnline(online: boolean): void;
    /** After another account took over the phone: its taps and photo counts are gone. */
    clearWaiting(): void;
  };
  readTimeoutMs: number;
  /** Shown when the day was never read in this page (judgement of the stored day waits for it). */
  isShown(): boolean;
}

export function createDayController<D extends { userId: string }>(ports: DayPorts<D>) {
  // R12-04: each read takes a number; an answer that arrives after a newer read, a sign-out or a refusal is ignored.
  let epoch = 0;
  // R14-06: the session generation changes at every sign-out, refusal and sign-in; `fenced` is true from the moment a sign-out starts
  // until the next sign-in (or until the driver declines to sign out).
  let generation = 0;
  let fenced = false;
  type GuardEntry = { kind: 'background' | 'drain'; gen: number; ctl: AbortController; op?: SignOutOp };
  const guards = new Set<GuardEntry>();
  const abortWhere = (pred: (g: GuardEntry) => boolean) => {
    for (const g of guards) if (pred(g)) g.ctl.abort();
  };

  const guardOf = (entry: GuardEntry): WorkGuard => {
    guards.add(entry);
    return {
      alive: () =>
        entry.gen === generation && !entry.ctl.signal.aborted && (entry.op ? entry.op.alive() : !fenced),
      signal: entry.ctl.signal,
      done: () => void guards.delete(entry),
    };
  };

  /** Starts a piece of background work under the current generation. Refused (null) while fenced. */
  function openWork(): WorkGuard | null {
    if (fenced) return null;
    return guardOf({ kind: 'background', gen: generation, ctl: new AbortController() });
  }

  /**
   * R15A-02: the sign-out is ONE operation, captured before its first await. Every stage of it (the sync, the photo send) takes its
   * guard from THIS operation (`openDrain`) and from nowhere else; a guard is never minted from "the current generation". The
   * operation ends for good when its deadline passes, the driver declines, the session is refused or a new sign-in opens a new
   * generation: after that it opens no guard and its guards are dead, so a continuation that wakes up late does nothing.
   * It also FENCES: nothing new starts from now until the next sign-in (or until the operation is cancelled).
   */
  function beginSignOut(): SignOutOp {
    fenced = true;
    abortWhere((g) => g.kind === 'background');
    const gen = generation;
    let ended = false;
    const op: SignOutOp = {
      alive: () => !ended && gen === generation,
      end: () => {
        ended = true;
        abortWhere((g) => g.op === op);
      },
      cancel: () => {
        op.end();
        if (gen === generation) fenced = false; // the driver stays: background work resumes (only if no newer session began)
      },
      openDrain: () => (op.alive() ? guardOf({ kind: 'drain', gen, ctl: new AbortController(), op }) : null),
    };
    return op;
  }
  /** A new sign-in: a new generation; nothing started before it can commit into it. */
  function signedIn(): void {
    generation++;
    abortWhere(() => true);
    fenced = false;
  }
  /** The result of a wipe: anything but an explicit `complete: true` is an incomplete erase, shown and kept for retry. */
  const reportErase = (r: unknown): void => {
    const done = typeof r === 'object' && r !== null && (r as { complete?: unknown }).complete !== false;
    ports.ui.setEraseIncomplete?.(!done);
    ports.ui.setEraseNotPersisted?.(
      typeof r === 'object' && r !== null && (r as { persistFailed?: unknown }).persistFailed === true,
    );
  };
  const cleanup = (job: () => Promise<void>) => {
    void job().catch(() => undefined); // independent of the screen and of the next read (rule 2)
  };

  /** Rule 1 + 2. Whatever answer is still on its way belongs to a session that is over. */
  function clearNow(session: 'out' | 'unknown', wipe: WipeScope | 'read' = 'read'): void {
    epoch++;
    generation++;
    abortWhere(() => true);
    ports.ui.setDay(null);
    ports.ui.setSession(session);
    cleanup(
      wipe === 'read'
        ? ports.forgetRead
        : () => ports.forgetAll(wipe).then(reportErase, () => reportErase({ complete: false })),
    );
  }

  const refused = (): void => clearNow('out');

  /** `guard`: the work that asks for the read (a sync, an upload). Refused while fenced, or once the guard's session is over. */
  async function loadDay(guard?: WorkGuard | null, opts: { conditional?: boolean } = {}): Promise<void> {
    if (fenced || (guard && !guard.alive())) return;
    const mine = ++epoch;
    const gen = generation;
    const ctl = new AbortController();
    const deadline = setTimeout(() => ctl.abort(), ports.readTimeoutMs);
    const current = () => mine === epoch && gen === generation && !fenced;
    try {
      const res = await ports.fetchSession(ctl.signal, opts.conditional === true);
      if (!current()) return;
      if (res.status === 401) return refused();
      if (res.status === 304) {
        // Nothing changed since the day this phone shows: the server vouches for it again (the stored day's age restarts) and nothing else moves.
        // Without a stored day of this account there is nothing to vouch for: read it in full.
        const kept = readStoredDay<D>(ports.local.get(DAY_STORAGE_KEY), ports.now());
        if (kept && kept.userId === ports.owner.get()) {
          ports.local.set(DAY_STORAGE_KEY, JSON.stringify(wrapDay(kept.userId, kept.day, ports.now())));
          ports.ui.setOnline(true);
          return;
        }
        clearTimeout(deadline);
        return loadDay(guard, { conditional: false });
      }
      if (!res.ok) throw new Error('bad');
      const data = (await res.json()) as D;
      if (!current()) return;
      // Another account on this phone: its day, its taps and its photos are erased before this account sees anything of them.
      const photos = await ports.queuedPhotos().catch((e: { rows?: { userId: string }[] }) => e?.rows ?? []);
      if (!current()) return;
      const holders = [
        readStoredDay<D>(ports.local.get(DAY_STORAGE_KEY), ports.now())?.userId,
        ports.owner.get(),
        ...photos.map((p) => p.userId),
      ];
      if (mustWipeForAccount(data.userId, holders)) {
        // A wipe of somebody else's data is completed whatever happens to this read, but it only erases what is not this account's...
        await ports
          .forgetAll({ except: data.userId })
          .then(reportErase, () => reportErase({ complete: false }));
        // ...and the epoch is checked BEFORE the queue shown is touched: a stale wipe changes nothing of a newer session (R14-06).
        if (!current()) return;
        ports.ui.clearWaiting();
      }
      // No await from here to the end of the commit: the epoch just checked is the epoch committed under.
      ports.owner.set(data.userId);
      ports.local.set(DAY_STORAGE_KEY, JSON.stringify(wrapDay(data.userId, data, ports.now())));
      ports.local.set(QUEUE_STORAGE_KEY, JSON.stringify({ userId: data.userId, actions: ports.queueNow() }));
      ports.ui.setDay(data);
      ports.ui.setSession('in');
      ports.ui.setOnline(true);
    } catch {
      if (!current()) return; // an obsolete read that failed says nothing about the present
      // No network: the last day read stays on screen, for the account that read it and for a limited time only.
      const kept = readStoredDay<D>(ports.local.get(DAY_STORAGE_KEY), ports.now());
      if (kept) {
        ports.owner.set(kept.userId);
        ports.ui.setDay(kept.day);
        ports.ui.setSession('in');
      } else {
        ports.ui.setDay(null);
        ports.ui.setSession('out');
        cleanup(ports.forgetRead);
      }
      ports.ui.setOnline(false);
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * R11-06: the limit is enforced while the page is open and when it comes back, and revocation is looked for whether or not there is
   * queued work. A day that is no longer valid leaves the screen and the phone NOW; the read that follows can only bring a new day
   * back if the server vouches for it.
   */
  async function recheck(): Promise<void> {
    if (!ports.isShown()) return;
    const verdict = judgeDay(ports.local.get(DAY_STORAGE_KEY), ports.now());
    if (verdict === 'fresh') return;
    if (verdict === 'none') clearNow('unknown');
    await loadDay();
  }

  /** An explicit sign-out: the screen is cleared at once; the server call and the erasing follow on their own. */
  function signedOut(): void {
    const leaving = ports.owner.get();
    ports.owner.set(null);
    fenced = true; // stays fenced until the next sign-in
    clearNow('out', leaving ? { only: leaving } : 'everything');
  }

  return {
    loadDay,
    recheck,
    refused,
    signedOut,
    openWork,
    beginSignOut,
    signedIn,
    isFenced: () => fenced,
    generation: () => generation,
    epoch: () => epoch,
  };
}
