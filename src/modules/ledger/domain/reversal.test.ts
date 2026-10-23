import { describe, expect, it } from 'vitest';
import { daysBetween, needsOldEntryPermission } from './reversal';

describe('reversal window (AC-LED-17)', () => {
  it('counts whole days across month ends', () => {
    expect(daysBetween('2026-01-30', '2026-02-02')).toBe(3);
    expect(daysBetween('2026-02-02', '2026-01-30')).toBe(-3);
    expect(daysBetween('2026-06-01', '2026-06-01')).toBe(0);
  });

  it('an entry inside the window (2 days) needs no old-entry permission; one day older does', () => {
    expect(needsOldEntryPermission('2026-06-01', '2026-06-01', 2)).toBe(false);
    expect(needsOldEntryPermission('2026-06-01', '2026-06-03', 2)).toBe(false);
    expect(needsOldEntryPermission('2026-06-01', '2026-06-04', 2)).toBe(true);
    expect(needsOldEntryPermission('2026-06-01', '2026-06-02', 0)).toBe(true);
  });
});
