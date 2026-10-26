import { describe, expect, it } from 'vitest';
import { normalizeSearchQuery, SearchRateLimiter } from './search';

describe('normalizeSearchQuery (AC-INT-18)', () => {
  it('upper-cases, drops the spaces and keeps the number', () => {
    expect(normalizeSearchQuery('  fa-2026-0012 ')).toEqual({ ok: true, value: 'FA-2026-0012' });
    expect(normalizeSearchQuery('BL 2026')).toEqual({ ok: true, value: 'BL2026' });
    expect(normalizeSearchQuery('N123/45')).toEqual({ ok: true, value: 'N123/45' });
  });
  it('wants four characters at least', () => {
    for (const q of ['', ' ', 'FA', 'FA-', 'cmd'])
      expect(normalizeSearchQuery(q)).toEqual({ ok: false, error: 'TOO_SHORT' });
    expect(normalizeSearchQuery('FA-2').ok).toBe(true);
  });
  it.each(['%%%%', 'FA_20', "FA-2026'; DROP", 'Atlas Béton', '--FA-1', 'x'.repeat(41), 'FA-2026*'])(
    'refuses %s: not a document number',
    (q) => {
      const r = normalizeSearchQuery(q);
      expect(r.ok).toBe(false);
    },
  );
});

describe('SearchRateLimiter', () => {
  it('lets an actor search `limit` times a window, then refuses until the window moves', () => {
    const limiter = new SearchRateLimiter(3, 1000);
    expect([0, 100, 200, 300].map((t) => limiter.take('a', t))).toEqual([true, true, true, false]);
    expect(limiter.take('b', 300)).toBe(true);
    expect(limiter.take('a', 1001)).toBe(true);
  });
});
