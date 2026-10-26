export const MIN_SEARCH_LENGTH = 4;
export const MAX_SEARCH_LENGTH = 40;

export type SearchQueryError = 'TOO_SHORT' | 'INVALID';

/**
 * A document number typed in a search box (AC-INT-18): trimmed, upper-cased, at least four characters, and only what a
 * document number is made of (letters, digits, dash, slash). Anything else is refused before the database is asked, so the
 * box is not a way to search free text, names or patterns. Pure.
 */
export function normalizeSearchQuery(
  raw: string,
): { ok: true; value: string } | { ok: false; error: SearchQueryError } {
  const value = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (value.length < MIN_SEARCH_LENGTH) return { ok: false, error: 'TOO_SHORT' };
  if (value.length > MAX_SEARCH_LENGTH || !/^[A-Z0-9][A-Z0-9/-]*$/.test(value))
    return { ok: false, error: 'INVALID' };
  return { ok: true, value };
}

/**
 * A sliding window per actor: at most `limit` searches in `windowMs`. Per process (the app runs as one), injectable clock.
 * The database's own lock-out (ten unknown probes in ten minutes) is the part that survives a restart.
 */
export class SearchRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit = 30, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** True and counted when the actor may search now; false when the window is full. */
  take(actor: string, now: number): boolean {
    const recent = (this.hits.get(actor) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(actor, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(actor, recent);
    return true;
  }
}
