// Client only. The phone's reading of the day, its refusal and its expiry (R11-06, R12-04, R13-03), apart from React so that the
// ordering rules can be tested with slow storage. Three rules, in this order of importance:
//   1. WHAT IS SHOWN is cleared synchronously at a refusal, an expiry or a sign-out: before any await, whatever storage or the network do.
//   2. STORAGE CLEANUP (local storage, IndexedDB photos, Cache Storage) runs on its own: the screen never waits for it, and a failing or
//      slow cleanup never blocks the next read.
//   3. EVERY await is followed by an epoch check before anything is COMMITTED (the screen, the owner, the stored day, the stored queue).
//      A read that is overtaken by a refusal, a sign-out or a newer read changes nothing. Wipes of another account's data are not commits:
//      they are always completed.
import { judgeDay, mustWipeForAccount, readStoredDay, wrapDay } from '../domain/offline';
import { DAY_KEY as DAY_STORAGE_KEY, QUEUE_KEY as QUEUE_STORAGE_KEY } from './offline-store';

export interface DayPorts<D extends { userId: string }> {
  /** The session read; aborted by the signal. */
  fetchSession(signal: AbortSignal): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
  now(): number;
  local: { get(key: string): string | null; set(key: string, value: string): void };
  /** Erase what names a client (the stored day, the caches); the queued work stays. */
  forgetRead(): Promise<void>;
  /** Erase everything of the phone: day, caches, queue, photos. */
  forgetAll(): Promise<void>;
  queuedPhotos(): Promise<{ userId: string }[]>;
  owner: { get(): string | null; set(id: string | null): void };
  /** The taps waiting to be sent, as they are now (for the stored copy). */
  queueNow(): unknown;
  ui: {
    setDay(day: D | null): void;
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
  const cleanup = (job: () => Promise<void>) => {
    void job().catch(() => undefined); // independent of the screen and of the next read (rule 2)
  };

  /** Rule 1 + 2. Whatever answer is still on its way belongs to a session that is over. */
  function clearNow(session: 'out' | 'unknown', wipe: 'read' | 'all' = 'read'): void {
    epoch++;
    ports.ui.setDay(null);
    ports.ui.setSession(session);
    cleanup(wipe === 'all' ? ports.forgetAll : ports.forgetRead);
  }

  const refused = (): void => clearNow('out');

  async function loadDay(): Promise<void> {
    const mine = ++epoch;
    const ctl = new AbortController();
    const deadline = setTimeout(() => ctl.abort(), ports.readTimeoutMs);
    const current = () => mine === epoch;
    try {
      const res = await ports.fetchSession(ctl.signal);
      if (!current()) return;
      if (res.status === 401) return refused();
      if (!res.ok) throw new Error('bad');
      const data = (await res.json()) as D;
      if (!current()) return;
      // Another account on this phone: its day, its taps and its photos are erased before this account sees anything of them.
      const photos = await ports.queuedPhotos().catch(() => []);
      if (!current()) return;
      const holders = [
        readStoredDay<D>(ports.local.get(DAY_STORAGE_KEY), ports.now())?.userId,
        ports.owner.get(),
        ...photos.map((p) => p.userId),
      ];
      if (mustWipeForAccount(data.userId, holders)) {
        // A wipe of somebody else's data is completed whatever happens to this read (not a commit)...
        await ports.forgetAll().catch(() => undefined);
        ports.ui.clearWaiting();
        // ...but nothing of this read is shown or stored unless it is still the current one.
        if (!current()) return;
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
    ports.owner.set(null);
    clearNow('out', 'all');
  }

  return { loadDay, recheck, refused, signedOut, epoch: () => epoch };
}
