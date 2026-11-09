import { beforeEach, describe, expect, it } from 'vitest';
import { allowRead, resetReadLimit } from './read-limit';

beforeEach(resetReadLimit);

describe('the read limit of the polled endpoints', () => {
  it('allows up to the maximum in a window, then refuses, per key', () => {
    for (let i = 0; i < 5; i++) expect(allowRead('a', 1000 + i, 5, 60_000)).toBe(true);
    expect(allowRead('a', 1010, 5, 60_000)).toBe(false);
    expect(allowRead('b', 1010, 5, 60_000)).toBe(true);
  });
  it('a new window starts after the old one', () => {
    for (let i = 0; i < 6; i++) allowRead('a', 1000, 5, 60_000);
    expect(allowRead('a', 1000 + 60_000, 5, 60_000)).toBe(true);
  });
  it('a poll every 12 s is far below the default', () => {
    let allowed = 0;
    for (let t = 0; t < 600_000; t += 12_000) if (allowRead('phone', t)) allowed++;
    expect(allowed).toBe(50);
  });
});
