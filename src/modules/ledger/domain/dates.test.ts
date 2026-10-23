import { describe, expect, it } from 'vitest';
import { addDaysIso, isRealDate } from './dates';

describe('dates', () => {
  it('adds days across month and year ends and a leap day', () => {
    expect(addDaysIso('2026-11-02', 30)).toBe('2026-12-02');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('only real calendar dates are accepted', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-4-1')).toBe(false);
    expect(() => addDaysIso('2026-02-30', 1)).toThrow(RangeError);
  });
});
