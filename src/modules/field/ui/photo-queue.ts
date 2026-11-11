// Client only. The photos of signed BLs wait in the phone's IndexedDB until the server has them (a photo is too big for the
// localStorage queue of the taps). Nothing here is trusted by the server: it checks type, bytes, rotation and time again.
import { fitWithin, photoVerdict, type PhotoVerdict } from '../domain/photo';
import type { WipeScope } from './day-controller';

export interface QueuedPhoto {
  key: string;
  tripId: string;
  takenAt: string;
  blob: Blob;
  /** The account that took it: another account never sends it, and signing out or switching account erases it (F02). */
  userId: string;
  /**
   * R15A-03 / T10c: a creation stamp, taken when the photo is queued (before any wait) from a PERSISTENT monotonic epoch shared by every page
   * of this phone (a counter in the database itself, never a clock: reloads, other tabs and a clock set back cannot reorder it). A wipe takes
   * its cutoff from the same counter when it STARTS and erases only photos stamped at or before it; a photo without a stamp counts as old.
   */
  seq?: number;
}

const DB = 'kayas-field';
const DB_VERSION = 2;
/** The database of the application's former name (BELGOBETON). Its unsent photos are migrated to the new database, then it is deleted. */
export const LEGACY_DB = 'belgobeton-field';
const STORE = 'photos';
/** T10c: small facts of the new database: the persistent epoch, the tombstones of the wipes, the fallback lock. */
const META = 'meta';
/** R16-02: set while the deletion of the former database is not proven to be finished (blocked or failed); retried on next load and before any wipe. */
export const LEGACY_PENDING_KEY = 'kayas_legacy_cleanup_pending';
const LOCK_NAME = 'kayas-photo-store';

/** What happened to the deletion of the former database. Only `deleted` is a success: `blocked` (another page holds it open) and `error` are not. */
export type LegacyOutcome = 'deleted' | 'blocked' | 'error';

/**
 * T10c: test seams, read lazily from `globalThis.__kayasPhotoHooks` (undefined in production: nothing runs). `pause(point)` lets a test hold
 * the code at a named point (after the legacy snapshot, before the copy commits...); `fail(point)` makes that step throw, to prove the
 * failure is reported and not swallowed. Points: snapshot, copy, erase-new, erase-legacy, open-new, read-legacy, read-new, delete-legacy.
 */
interface Hooks {
  pause?: (point: string) => Promise<void> | void;
  fail?: (point: string) => boolean;
}
const hooks = (): Hooks | undefined => (globalThis as { __kayasPhotoHooks?: Hooks }).__kayasPhotoHooks;
async function point(name: string): Promise<void> {
  const h = hooks();
  if (!h) return;
  await h.pause?.(name);
  if (h.fail?.(name)) throw new Error(`injected failure at ${name}`);
}

const flag = {
  set: () => {
    try {
      localStorage.setItem(LEGACY_PENDING_KEY, '1');
    } catch {
      // no localStorage here: the state is then only what the database itself shows
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(LEGACY_PENDING_KEY);
    } catch {
      // see above
    }
  },
  isSet: () => {
    try {
      return localStorage.getItem(LEGACY_PENDING_KEY) === '1';
    } catch {
      return false;
    }
  },
};

/** A deletion asked by this page is queued behind an old page's connection: the database is not opened again meanwhile (the open would wait). */
let deletionQueued = false;

/** True while the former database may still be on this phone: show it, and it is retried before any wipe. */
export const legacyCleanupPending = (): boolean => flag.isSet();

/**
 * Asks for the deletion of the former-named database. `deleted` only when the browser says the deletion is done. `blocked` when another open
 * connection (an old page) holds it: the request stays queued in the browser and finishes when that page closes, but this call does NOT
 * count that as success: the pending state is kept and the deletion is retried. `error` otherwise. Never throws.
 */
export function deleteLegacyPhotoStore(): Promise<LegacyOutcome> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(LEGACY_DB);
      let settled = false;
      const settle = (outcome: LegacyOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      req.onsuccess = () => {
        deletionQueued = false;
        flag.clear(); // also when the browser finishes a deletion that was blocked earlier, once the old page is closed
        settle('deleted');
      };
      req.onerror = () => {
        deletionQueued = false;
        flag.set();
        settle('error');
      };
      req.onblocked = () => {
        // the request stays queued in the browser: until it finishes, opening that database waits behind it, so this page does not reopen it
        deletionQueued = true;
        flag.set();
        settle('blocked');
      };
    } catch {
      flag.set();
      resolve('error');
    }
  });
}

/** R18-06: the former database could not be opened in time (an old page holds it, or a deletion/fence is queued behind one): what it holds is UNKNOWN, not empty. */
export class LegacyBlocked extends Error {
  constructor() {
    super('the former photo database is blocked: its photos cannot be read or erased now');
    this.name = 'LegacyBlocked';
  }
}

/** Does the former database exist on this phone? (Opening a missing one would create it.) */
async function legacyExists(): Promise<boolean> {
  if (typeof indexedDB.databases === 'function') {
    return (await indexedDB.databases()).some((d) => d.name === LEGACY_DB);
  }
  return true; // cannot be told: the open below aborts and deletes a database it had to create
}

/**
 * Opens the former database; it closes itself when another page wants to delete or upgrade it, so it never blocks that. Null when it did not
 * exist (nothing is created: the upgrade is aborted) or when it has no photo store any more (fenced): those are PROVEN empty. When the browser
 * did not answer in time, or a deletion/fence is queued behind an old page, it REJECTS with `LegacyBlocked` (R18-06): unknown is not empty.
 */
function openLegacy(): Promise<IDBDatabase | null> {
  if (deletionQueued) return Promise.reject(new LegacyBlocked());
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new LegacyBlocked());
    }, 1500);
    const req = indexedDB.open(LEGACY_DB);
    let created = false;
    req.onupgradeneeded = () => {
      created = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => db.close();
      if (timedOut || created || !db.objectStoreNames.contains(STORE)) {
        db.close();
        if (!timedOut) resolve(null);
      } else resolve(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (timedOut) return;
      if (created) resolve(null);
      else reject(req.error);
    };
    req.onblocked = () => undefined;
  });
}

function readAll(db: IDBDatabase): Promise<QueuedPhoto[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedPhoto[]);
    req.onerror = () => reject(req.error);
  });
}

/** The unsent photos still in the former database (read only). Rejects when they cannot be read: the caller must say so, not assume none. */
async function legacyRows(): Promise<QueuedPhoto[]> {
  if (!(await legacyExists())) return [];
  const db = await openLegacy();
  if (!db) return [];
  try {
    await point('read-legacy');
    return await readAll(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The new database, its epoch, its tombstones, its lock
// ---------------------------------------------------------------------------------------------------------------------------------

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    void point('open-new').then(() => {
      const req = indexedDB.open(DB, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META);
          // The persistent epoch starts above every stamp an earlier build wrote from the wall clock (seconds x 1000 at most), and only ever grows by one.
          req.transaction?.objectStore(META).put(Date.now() * 1000, 'epoch');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    }, reject);
  });
}

/** One readwrite transaction on the meta store; resolves when it COMMITS. */
async function meta<T>(fn: (s: IDBObjectStore, done: (v: T) => void) => void): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(META, 'readwrite');
      let value: T;
      fn(tx.objectStore(META), (v) => {
        value = v;
      });
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/**
 * The next stamp of the persistent epoch: one atomic read-increment-write in the database, so two tabs (or a reload, or a clock set back)
 * can never draw the same or a lower number than one drawn before. It is the creation stamp of a photo and the cutoff of a wipe.
 */
export function reserveEpoch(): Promise<number> {
  return meta<number>((s, done) => {
    const get = s.get('epoch');
    get.onsuccess = () => {
      const next = (typeof get.result === 'number' ? get.result : Date.now() * 1000) + 1;
      s.put(next, 'epoch');
      done(next);
    };
  });
}
const currentEpoch = (): Promise<number> =>
  meta<number>((s, done) => {
    const get = s.get('epoch');
    get.onsuccess = () => done(typeof get.result === 'number' ? get.result : 0);
  });

interface Tombstone {
  /** The epoch at which the wipe took its cutoff. */
  at: number;
  cutoff: number;
  scope: WipeScope;
  /**
   * R18-06: true until the wipe has PROVEN that the former database holds nothing it covers any more (erased, or fenced/deleted). While open, every
   * copy applies this tombstone to the former rows whatever the epoch of its snapshot (a snapshot taken between the wipe's epoch and its commit used to
   * ignore it), and it is never dropped by the cap. Absent on tombstones written before: they behave as closed.
   */
  open?: boolean;
  /**
   * R18-06: epoch stamps drawn INSIDE the transaction that committed the tombstone (`committed`) and the one that closed it (`closedAt`). A copy applies a
   * tombstone when any part of its life (still open, committed or closed) came after the copy's snapshot began; before this, only the wipe's reserved
   * epoch was compared, which is earlier than its commit, so a snapshot taken between the two ignored the tombstone and put an erased photo back.
   */
  committed?: number;
  closedAt?: number;
}
/** The newest event of a tombstone's life (reservation, commit, close). */
const lastEvent = (t: Tombstone): number => Math.max(t.at, t.committed ?? 0, t.closedAt ?? 0);
const MAX_TOMBSTONES = 50;
const covers = (t: Tombstone, row: QueuedPhoto): boolean =>
  (t.scope === 'everything'
    ? true
    : 'only' in t.scope
      ? row.userId === t.scope.only
      : row.userId !== t.scope.except) && (row.seq ?? 0) <= t.cutoff;

/**
 * Serializes everything that moves or erases photos across pages: the Web Locks API when the browser has it, else a lease in the database
 * (an expiring record, renewed while held). A lock that cannot be had in time REJECTS: the caller reports an incomplete operation.
 */
/** The fallback lease a section holds (null with Web Locks, which cannot be lost mid-section). Every write transaction below re-validates it. */
export type Held = { me: string } | null;

/** R18-06: inside a write transaction on the new database, abort it when the section's fallback lease expired or was taken over. */
function guardLease(tx: IDBTransaction, held: Held): void {
  if (!held) return;
  const lk = tx.objectStore(META).get('lock');
  lk.onsuccess = () => {
    const cur = lk.result as { owner: string; until: number } | undefined;
    if (!cur || cur.owner !== held.me || cur.until < Date.now()) tx.abort();
  };
}

export async function withStoreLock<T>(fn: (held: Held) => Promise<T>): Promise<T> {
  const locks = (
    globalThis as { navigator?: { locks?: { request: (n: string, cb: () => Promise<T>) => Promise<T> } } }
  ).navigator?.locks;
  if (locks?.request) return locks.request(LOCK_NAME, () => fn(null));
  const me = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const LEASE_MS = 10_000;
  const acquire = () =>
    meta<boolean>((s, done) => {
      const get = s.get('lock');
      get.onsuccess = () => {
        const cur = get.result as { owner: string; until: number } | undefined;
        if (!cur || cur.until < Date.now() || cur.owner === me) {
          s.put({ owner: me, until: Date.now() + LEASE_MS }, 'lock');
          done(true);
        } else done(false);
      };
    });
  const deadline = Date.now() + 20_000;
  while (!(await acquire())) {
    if (Date.now() > deadline) throw new Error('photo store busy: the lock could not be had');
    await new Promise((r) => setTimeout(r, 40));
  }
  const beat = setInterval(() => void acquire().catch(() => undefined), LEASE_MS / 3);
  try {
    return await fn({ me });
  } finally {
    clearInterval(beat);
    await meta<void>((s, done) => {
      const get = s.get('lock');
      get.onsuccess = () => {
        if ((get.result as { owner?: string } | undefined)?.owner === me) s.delete('lock');
        done(undefined);
      };
    }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The migration of the former database (T10c: fenced, serialized, tombstone-checked, never deleting what was not copied)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The FENCE. A versionchange transaction on the former database runs only when no page holds it open, and nobody can write while it runs. If
 * the photo store is empty inside it, the store is removed: an old page that opens it later cannot write a photo that nothing would send or
 * erase (it fails loudly). If it holds a row, the upgrade is aborted and nothing changes (`rows`). `blocked`: an old page keeps it open.
 */
function fenceLegacy(): Promise<'fenced' | 'rows' | 'blocked' | 'error'> {
  if (deletionQueued) return Promise.resolve('blocked'); // a request of this page is already queued on it
  return new Promise((resolve) => {
    try {
      let probed = false;
      // an open that waits behind a queued request answers nothing: that is "blocked", not a hang
      const waitTimer = setTimeout(() => {
        if (!probed) resolve('blocked');
      }, 1500);
      const probe = indexedDB.open(LEGACY_DB);
      probe.onerror = () => resolve('error');
      probe.onupgradeneeded = () => probe.transaction?.abort(); // it did not exist: nothing created
      probe.onsuccess = () => {
        probed = true;
        clearTimeout(waitTimer);
        const db = probe.result;
        const version = db.version;
        const has = db.objectStoreNames.contains(STORE);
        db.close();
        if (!has) return resolve('fenced');
        const req = indexedDB.open(LEGACY_DB, version + 1);
        let outcome: 'fenced' | 'rows' | 'error' | null = null;
        req.onupgradeneeded = () => {
          const tx = req.transaction as IDBTransaction;
          const count = tx.objectStore(STORE).count();
          count.onsuccess = () => {
            if (count.result > 0) {
              outcome = 'rows';
              tx.abort();
            } else {
              req.result.deleteObjectStore(STORE);
              outcome = 'fenced';
            }
          };
        };
        let wasBlocked = false;
        req.onsuccess = () => {
          deletionQueued = false;
          req.result.close();
          resolve(outcome ?? 'fenced');
          // the queued fence ran after the old page let go and removed the (empty) store: now the cleanup of the database itself
          if (wasBlocked && outcome !== 'rows') void deleteLegacyPhotoStore();
        };
        req.onerror = () => {
          deletionQueued = false;
          resolve(outcome === 'rows' ? 'rows' : 'error');
        };
        // The request stays queued in the browser and runs (atomically) when the old page lets go; until then it holds the database's queue,
        // so this page does not open it again (same rule as a queued deletion). The pending flag stays, and the next load finishes the cleanup.
        req.onblocked = () => {
          deletionQueued = true;
          wasBlocked = true;
          resolve('blocked');
        };
      };
    } catch {
      resolve('error');
    }
  });
}

type CopyResult = 'none' | 'copied' | 'error';

/**
 * One round: snapshot the former rows, COPY them into the new database in one transaction (skipping a photo already there, and a photo a
 * wipe that started after the snapshot has erased), and only after that commit take out of the former database exactly the keys it handled.
 * Rows an old page wrote after the snapshot are not in the copy, so they are never touched here (the next round copies them).
 */
async function copyRound(held: Held): Promise<CopyResult> {
  if (deletionQueued || !(await legacyExists())) return 'none';
  let rows: QueuedPhoto[];
  let snapshotEpoch: number;
  try {
    snapshotEpoch = await currentEpoch();
    rows = await legacyRows();
    await point('snapshot');
  } catch {
    return 'error';
  }
  if (rows.length === 0) return 'copied';
  const handled: string[] = [];
  try {
    await point('copy');
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, META], 'readwrite');
        guardLease(tx, held);
        const store = tx.objectStore(STORE);
        const wipes = tx.objectStore(META).get('wipes');
        wipes.onsuccess = () => {
          const tombs = ((wipes.result as Tombstone[] | undefined) ?? []).filter(
            (t) => t.open === true || lastEvent(t) > snapshotEpoch,
          );
          for (const row of rows) {
            // a wipe took its cutoff after this snapshot began: the photo it covers was erased on purpose and is not put back
            if (tombs.some((t) => covers(t, { ...row, seq: row.seq ?? 0 }))) {
              handled.push(row.key);
              continue;
            }
            const exists = store.getKey(row.key);
            exists.onsuccess = () => {
              if (exists.result === undefined) store.put({ ...row, seq: row.seq ?? 0 });
              handled.push(row.key);
            };
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('copy aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    return 'error'; // nothing was committed: the former rows stay exactly as they were
  }
  // Committed. Take out ONLY the keys the committed copy handled.
  const legacy = await openLegacy().catch(() => null);
  if (legacy) {
    await new Promise<void>((resolve) => {
      const tx = legacy.transaction(STORE, 'readwrite');
      for (const key of handled) tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    }).finally(() => legacy.close());
  }
  return 'copied';
}

/** The migration proper, to be called under the store lock. Returns what became of the former database. */
async function migrateLocked(held: Held): Promise<LegacyOutcome | 'none' | 'error-copy'> {
  if (deletionQueued) return 'blocked';
  if (!(await legacyExists().catch(() => true))) {
    flag.clear();
    await closeAllTombstones(held).catch(() => undefined); // nothing is left to cover
    return 'none';
  }
  for (let round = 0; round < 6; round++) {
    const copied = await copyRound(held);
    if (copied === 'none') {
      if (!(await legacyExists().catch(() => true))) {
        flag.clear();
        await closeAllTombstones(held).catch(() => undefined);
      }
      return flag.isSet() ? 'blocked' : 'none';
    }
    if (copied === 'error') {
      flag.set();
      return 'error-copy';
    }
    // the copy is committed and the former rows it handled are out: fence, which only succeeds when nothing is left (and nobody is writing)
    const fenced = await fenceLegacy();
    if (fenced === 'fenced') {
      await closeAllTombstones(held).catch(() => undefined); // fenced: the store is gone, nobody can write a photo there any more
      await point('delete-legacy').catch(() => {
        flag.set();
      });
      return deleteLegacyPhotoStore();
    }
    if (fenced === 'blocked') {
      flag.set();
      return 'blocked';
    }
    if (fenced === 'error') {
      flag.set();
      return 'error';
    }
    // 'rows': an old page wrote after the snapshot: another round copies it
  }
  flag.set();
  return 'blocked'; // an old page keeps writing: the former database stays, with its rows, and is reported as pending
}

/**
 * Copies the former database's photos, then (only when everything is moved and the database is fenced) asks for its deletion and returns the
 * outcome. Also the retry of a pending deletion. `none` when there is no former database. Serialized with every wipe, across pages.
 */
export async function migrateLegacyPhotos(): Promise<LegacyOutcome | 'none'> {
  const r = await withStoreLock((held) => migrateLocked(held));
  return r === 'error-copy' ? 'error' : r;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading, writing, erasing
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * R15B-04: a request that succeeded is not a write that is durable. A readwrite operation is finished when its TRANSACTION completes; an abort
 * (or an error) after the request's success rejects. A readonly read has nothing to commit, so its result is returned when the request succeeds.
 */
function finish<T>(tx: IDBTransaction, req: IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    tx.onabort = () => reject(tx.error ?? req.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error ?? req.error);
    if (mode === 'readonly') req.onsuccess = () => resolve(req.result);
    else tx.oncomplete = () => resolve(req.result);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return finish(tx, req, mode).finally(() => db.close());
}

/**
 * R15A-04: `stillCurrent` is asked AFTER the (possibly slow) database opening and in the same synchronous step that issues the write,
 * so a session that ended while the photo was being prepared or the database was opening never gets its photo stored. If the session
 * ends while the write is on its way, the row is taken out again. Answers whether the photo was kept.
 */
export async function queuePhoto(p: QueuedPhoto, stillCurrent: () => boolean = () => true): Promise<boolean> {
  const row: QueuedPhoto = { ...p, seq: p.seq ?? (await reserveEpoch()) };
  const db = await open();
  if (!stillCurrent()) {
    db.close();
    return false;
  }
  const tx = db.transaction(STORE, 'readwrite');
  try {
    await finish(tx, tx.objectStore(STORE).put(row), 'readwrite');
  } finally {
    db.close();
  }
  if (stillCurrent()) return true;
  // The session ended while the write was on its way: take the row out again. A failed removal is NOT swallowed, because the row
  // would still be on the phone (R15B-04): the caller must not treat the sign-out as erased.
  try {
    await dropPhoto(row.key);
  } catch {
    throw new Error('photo cleanup failed: the stale photo may still be stored');
  }
  return false;
}

/** Raised by `queuedPhotos` when some photos could not be read: `rows` is what could be, and the real number of photos is UNKNOWN (at least these). */
export class PhotoListIncomplete extends Error {
  constructor(readonly rows: QueuedPhoto[]) {
    super('some queued photos could not be read');
    this.name = 'PhotoListIncomplete';
  }
}

/**
 * Every unsent photo of this phone. A leftover of the former database is migrated first (and its deletion retried when it is still pending);
 * whatever could not be moved yet is still listed, so it is counted by the sign-out confirmation and never silently lost. When any store cannot be
 * read the call REJECTS with `PhotoListIncomplete`: a count built from it is "at least this many, unknown".
 */
export async function queuedPhotos(): Promise<QueuedPhoto[]> {
  let unreadable = false;
  if (flag.isSet() || (await legacyExists().catch(() => false)))
    await migrateLegacyPhotos().catch(() => {
      unreadable = true;
    });
  let rows: QueuedPhoto[] = [];
  try {
    await point('read-new');
    rows = await run<QueuedPhoto[]>('readonly', (s) => s.getAll());
  } catch {
    unreadable = true;
  }
  const known = new Set(rows.map((r) => r.key));
  let left: QueuedPhoto[] = [];
  try {
    left = (await legacyRows()).filter((r) => !known.has(r.key));
  } catch {
    unreadable = true;
  }
  const all = [...rows, ...left];
  if (unreadable) throw new PhotoListIncomplete(all);
  return all;
}

/** What a wipe achieved. `complete` only when every store was erased within the scope and nothing is left to retry. */
export interface WipeResult {
  complete: boolean;
  legacy: LegacyOutcome | 'none';
  /** Which steps failed: the migration of the former database, the new store, the former store. */
  failed: ('migrate' | 'new-store' | 'legacy-store' | 'lock')[];
}

/**
 * Erases the photos within the scope, ONLY those stamped at or before `cutoff` (taken from the persistent epoch when the wipe starts), in one
 * transaction per store, and records a tombstone so that no delayed copy can put them back. Serialized with the migration across pages. Never
 * throws: every failure is in the result, and the caller keeps the erase pending.
 */
export async function wipePhotos(scope: WipeScope = 'everything', cutoff?: number): Promise<WipeResult> {
  const result: WipeResult = { complete: true, legacy: 'none', failed: [] };
  const fail = (what: WipeResult['failed'][number]) => {
    result.complete = false;
    if (!result.failed.includes(what)) result.failed.push(what);
  };
  try {
    await withStoreLock(async (held) => {
      const at = await reserveEpoch(); // the wipe's own place in the epoch (a copy that began before it must not put its photos back)
      const limit = cutoff ?? at;
      const inScope = (row: QueuedPhoto) =>
        (scope === 'everything'
          ? true
          : 'only' in scope
            ? row.userId === scope.only
            : row.userId !== scope.except) && (row.seq ?? 0) <= limit;
      // 1. move the former database's photos into the new one, so that one scope and one cutoff apply to all of them
      const migrated = await migrateLocked(held).catch((): 'error-copy' => 'error-copy');
      if (migrated === 'error-copy') fail('migrate');
      else result.legacy = migrated;
      // 2. the new store, and the tombstone, in ONE transaction. The tombstone is OPEN until the former database is proven clear of what it covers.
      const legacyGone = migrated === 'none' || migrated === 'deleted';
      try {
        await point('erase-new');
        await eraseNew(inScope, { at, cutoff: limit, scope, open: !legacyGone }, !legacyGone, held);
      } catch {
        fail('new-store');
      }
      // 3. whatever could not be moved (blocked, unreadable) is erased in the former database too, within the same scope
      if (!legacyGone) {
        try {
          await point('erase-legacy');
          const db = await openLegacy();
          if (db) await eraseRows(db, inScope);
          // proven: the former database holds nothing this wipe covers (or has no photo store at all), so the tombstone may close
          await closeTombstone(at, held).catch(() => undefined);
        } catch (error) {
          // R18-06: a former database that cannot be opened in time is UNKNOWN, not clear: the tombstone stays open and the wipe is incomplete
          // (it is reported as `blocked`, which is what an old page holding the database is); any other failure is a failed erase of that store
          if (error instanceof LegacyBlocked) {
            if (result.legacy === 'none' || result.legacy === 'deleted') result.legacy = 'blocked';
          } else fail('legacy-store');
        }
      }
    });
  } catch {
    fail('lock');
  }
  if (result.legacy === 'blocked' || result.legacy === 'error') result.complete = false;
  return result;
}

/** The rows in scope out of the new store, and the tombstone in, in one transaction that must COMMIT. */
async function eraseNew(
  inScope: (row: QueuedPhoto) => boolean,
  tomb: Tombstone,
  keepEvery: boolean,
  held: Held,
): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      guardLease(tx, held); // R18-06: a lease that expired since the section began aborts the erase instead of letting it commit
      const cursor = tx.objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        if (inScope(c.value as QueuedPhoto)) c.delete();
        c.continue();
      };
      const m = tx.objectStore(META);
      const wipes = m.get('wipes');
      wipes.onsuccess = () => {
        const ep = m.get('epoch');
        ep.onsuccess = () => {
          const next = (typeof ep.result === 'number' ? ep.result : Date.now() * 1000) + 1;
          m.put(next, 'epoch'); // drawn in THIS transaction: the tombstone's commit has a place in the epoch
          const all = ((wipes.result as Tombstone[] | undefined) ?? []).concat({ ...tomb, committed: next });
          // R18-06: an open tombstone is never dropped, and no tombstone is dropped at all while the former database may still hold a photo
          const list = keepEvery
            ? all
            : [
                ...all.filter((t) => t.open === true),
                ...all.filter((t) => t.open !== true).slice(-MAX_TOMBSTONES),
              ].sort((x, y) => x.at - y.at);
          m.put(list, 'wipes');
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('erase aborted'));
    });
  } finally {
    db.close();
  }
}

/** Closes EVERY open tombstone: the former database is proven gone or fenced (no photo can be in it, none can be written), so none of them has a source left to cover. */
async function closeAllTombstones(held: Held): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META, 'readwrite');
      guardLease(tx, held);
      const m = tx.objectStore(META);
      const wipes = m.get('wipes');
      wipes.onsuccess = () => {
        const list = (wipes.result as Tombstone[] | undefined) ?? [];
        if (list.some((t) => t.open === true))
          m.put(
            list.map((t) => (t.open ? { ...t, open: false } : t)),
            'wipes',
          );
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('close aborted'));
    });
  } finally {
    db.close();
  }
}

/** Closes the tombstone of the wipe at epoch `at`: the former database is proven clear of what it covers. Under the lease like every write. */
async function closeTombstone(at: number, held: Held): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META, 'readwrite');
      guardLease(tx, held);
      const m = tx.objectStore(META);
      const wipes = m.get('wipes');
      wipes.onsuccess = () => {
        const list = ((wipes.result as Tombstone[] | undefined) ?? []).map((t) =>
          t.at === at ? { ...t, open: false } : t,
        );
        m.put(list, 'wipes');
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('close aborted'));
    });
  } finally {
    db.close();
  }
}

/** Erases the rows in scope of one database in ONE transaction that must commit, then closes the connection. */
function eraseRows(db: IDBDatabase, inScope: (row: QueuedPhoto) => boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (inScope(c.value as QueuedPhoto)) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('erase aborted'));
  }).finally(() => db.close());
}

export async function dropPhoto(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
  // a copy still in the former database (blocked deletion) is taken out too, or it would be sent again
  const db = await openLegacy().catch(() => null);
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('delete aborted'));
    });
  } finally {
    db.close();
  }
}

/** Re-draws the picture at most 1600 px wide as a JPEG: smaller to send, and the camera metadata (GPS) is not carried over. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.82),
  );
}

export async function sendPhoto(p: QueuedPhoto, signal?: AbortSignal): Promise<PhotoVerdict> {
  const body = new FormData();
  body.set('tripId', p.tripId);
  body.set('key', p.key);
  body.set('takenAt', p.takenAt);
  body.set('photo', new File([p.blob], 'bl.jpg', { type: p.blob.type || 'image/jpeg' }));
  try {
    const res = await fetch('/api/field/bl-photo', { method: 'POST', body, ...(signal ? { signal } : {}) });
    const error = res.ok
      ? undefined
      : ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    return photoVerdict(res.status, error);
  } catch {
    return 'retry';
  }
}
