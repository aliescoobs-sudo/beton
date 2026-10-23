import { describe, expect, it } from 'vitest';
import { isEarly, isIsoDate, isPostDated } from './instrument-dates';

describe('instrument dates', () => {
  it('a cheque written after the day it is received is post-dated', () => {
    expect(isPostDated('2026-12-01', '2026-11-20')).toBe(true);
    expect(isPostDated('2026-11-20', '2026-11-20')).toBe(false);
    expect(isPostDated('2026-11-01', '2026-11-20')).toBe(false);
  });

  it('an event before the written date is early; on or after it is not (AC-LED-14)', () => {
    expect(isEarly('2026-11-25', '2026-12-01')).toBe(true);
    expect(isEarly('2026-12-01', '2026-12-01')).toBe(false);
    expect(isEarly('2026-12-02', '2026-12-01')).toBe(false);
    expect(isEarly('2026-11-25', null)).toBe(false);
  });

  it('only real calendar-shaped dates count', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-02-28')).toBe(false);
    expect(isPostDated('nope', '2026-11-20')).toBe(false);
  });
});
