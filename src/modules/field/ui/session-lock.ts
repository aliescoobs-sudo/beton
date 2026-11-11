/**
 * R18-05: the phone's sign-in and sign-out requests of ALL tabs of the browser are serialized by one Web Lock, so a late "delete the cookie" answer of a
 * logout started in one tab cannot land after the Set-Cookie of a sign-in made in another (the server also refuses to clear a cookie whose session it did
 * not end). Where Web Locks do not exist the call simply runs; the server-side rule is the guarantee, the lock removes the race where it can.
 */
export const FIELD_SESSION_LOCK = 'kayas-field-session';

interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

export function withFieldSessionLock<T>(
  fn: () => Promise<T>,
  locks: LockManagerLike | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as { locks?: LockManagerLike }).locks,
): Promise<T> {
  if (!locks) return fn();
  return locks.request(FIELD_SESSION_LOCK, { mode: 'exclusive' }, fn);
}
