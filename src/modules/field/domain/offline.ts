// What the phone keeps for the road, and when it must forget (F02 of the final review). A leaf with no import. Everything the phone
// holds that names a client (the day, the photos of signed BLs) belongs to ONE account and ONE moment: it is shown offline only to the
// account that read it, only for a limited time, and it is wiped when that account leaves, is refused, or another account signs in.

/** The day read for the road is shown offline for this long at most (a working day and its margin), then the phone asks to sign in. */
export const OFFLINE_MAX_AGE_MS = 18 * 60 * 60 * 1000;

export interface StoredDay<T> {
  /** The account that read it. */
  userId: string;
  /** The phone's clock when the server answered. */
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
