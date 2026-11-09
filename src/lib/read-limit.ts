// A small per-key limit for read endpoints that a screen polls (T9: the driver's day and the plant's board refresh every 10-15 s). In memory,
// per server process: it bounds a runaway page or a script, it is not the login throttle (which is in the database).
const windows = new Map<string, { start: number; count: number }>();

/** True when `key` may read now: at most `max` reads per `windowMs`. Old windows are dropped as they are met. */
export function allowRead(key: string, now: number, max = 60, windowMs = 60_000): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    return true;
  }
  w.count += 1;
  return w.count <= max;
}

/** For tests: forget every window. */
export function resetReadLimit(): void {
  windows.clear();
}
