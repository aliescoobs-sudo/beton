// What the phone keeps for the road, and when it must forget (F02 of the final review). A leaf with no import. Everything the phone
// holds that names a client (the day, the photos of signed BLs) belongs to ONE account and ONE moment: it is shown offline only to the
// account that read it, only for a limited time, and it is wiped when that account leaves, is refused, or another account signs in.

/** The day read for the road is shown offline for this long at most (a working day and its margin), then the phone asks to sign in. */
export const OFFLINE_MAX_AGE_MS = 18 * 60 * 60 * 1000;

/** While a day is on screen the phone asks the server again at least this often (a revoked phone or account is found without any queued work). */
export const REVALIDATE_MS = 5 * 60 * 1000;

export interface StoredDay<T> {
  /** The account that read it. */
  userId: string;
  /** The phone's clock when the SERVER last answered. Local taps never move it (R11-06): it is the age of the authorisation. */
  savedAt: number;
  day: T;
}

export function wrapDay<T>(userId: string, day: T, now: number): StoredDay<T> {
  return { userId, savedAt: now, day };
}

/** The stored day, or null when it is absent, malformed, from the future, or older than the offline age. */
export function readStoredDay<T>(
  raw: string | null,
  now: number,
  maxAgeMs = OFFLINE_MAX_AGE_MS,
): StoredDay<T> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredDay<T>> | null;
    if (
      !v ||
      typeof v.userId !== 'string' ||
      !v.userId ||
      typeof v.savedAt !== 'number' ||
      v.day === undefined
    )
      return null;
    if (v.savedAt > now + 60_000 || now - v.savedAt > maxAgeMs) return null;
    return v as StoredDay<T>;
  } catch {
    return null;
  }
}

/**
 * A local tap changes the day shown, never the time the server last vouched for it (R11-06). Returns the new stored text with the
 * original `savedAt`, or null when there is no valid stored day of that account any more (absent, malformed, other account, expired):
 * nothing is written then, and the check below sends the phone back to the server or to the sign-in.
 */
export function rewrapDay<T>(
  raw: string | null,
  userId: string,
  day: T,
  now: number,
  maxAgeMs = OFFLINE_MAX_AGE_MS,
): string | null {
  const kept = readStoredDay<T>(raw, now, maxAgeMs);
  if (!kept || kept.userId !== userId) return null;
  return JSON.stringify({ userId, savedAt: kept.savedAt, day } satisfies StoredDay<T>);
}

/**
 * What the phone must do about the day it shows, at any moment (a timer, a return to the page, the network coming back):
 * `fresh` nothing; `stale` ask the server again (it may have been revoked; the day stays if the server cannot be reached, until it is
 * `none`); `none` there is no valid day (absent, malformed, from the future, older than the offline age): ask the server, and if it
 * cannot be reached, erase what names a client and show the sign-in.
 */
export function judgeDay(
  raw: string | null,
  now: number,
  maxAgeMs = OFFLINE_MAX_AGE_MS,
  revalidateMs = REVALIDATE_MS,
): 'fresh' | 'stale' | 'none' {
  const kept = readStoredDay<unknown>(raw, now, maxAgeMs);
  if (!kept) return 'none';
  return now - kept.savedAt > revalidateMs ? 'stale' : 'fresh';
}

export interface StoredQueue<A> {
  userId: string;
  actions: A[];
}

/** The queue of taps with its owner. A queue with no owner (the first version stored a bare list) is not adopted by anybody. */
export function readStoredQueue<A extends { key: string }>(raw: string | null): StoredQueue<A> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredQueue<A>> | null;
    if (!v || typeof v.userId !== 'string' || !v.userId || !Array.isArray(v.actions)) return null;
    return {
      userId: v.userId,
      actions: v.actions.filter((a) => a && typeof a === 'object' && typeof a.key === 'string'),
    };
  } catch {
    return null;
  }
}

/**
 * What to do with what the phone holds when the server says who is signed in: nothing (the same account), or wipe everything that
 * belongs to somebody else before the new account sees any of it. `holders` are the owners found in the phone (day, taps, photos).
 */
export function mustWipeForAccount(
  current: string,
  holders: readonly (string | null | undefined)[],
): boolean {
  return holders.some((h) => typeof h === 'string' && h !== current);
}
