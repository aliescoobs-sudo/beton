import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_DAYS, DEFAULT_SAFETY_DAYS, reorderThreshold, stockStatus } from './stock';

describe('reorderThreshold (AC-PROD-07)', () => {
  it('is the average daily consumption times the lead time plus the safety days, rounded up', () => {
    // 30 000 000 g used in 30 days = 1 000 000 g a day; cement: 2 days lead + 1 safety = 3 000 000 g
    expect(reorderThreshold({ consumedBase: 30_000_000, windowDays: 30, leadDays: 2, safetyDays: 1 })).toBe(
      3_000_000,
    );
    // sand ordered the day before: 0 days lead, 1 safety
    expect(reorderThreshold({ consumedBase: 30_000_000, windowDays: 30, leadDays: 0, safetyDays: 1 })).toBe(
      1_000_000,
    );
  });
  it('rounds up on integers, never down, and never uses a floating average', () => {
    expect(reorderThreshold({ consumedBase: 10, windowDays: 3, leadDays: 1, safetyDays: 0 })).toBe(4);
    expect(reorderThreshold({ consumedBase: 1, windowDays: 30, leadDays: 1, safetyDays: 0 })).toBe(1);
  });
  it('is null with no consumption or no window: the plant sets one by hand', () => {
    expect(reorderThreshold({ consumedBase: 0, windowDays: 30, leadDays: 2, safetyDays: 1 })).toBeNull();
    expect(reorderThreshold({ consumedBase: -5, windowDays: 30, leadDays: 2, safetyDays: 1 })).toBeNull();
    expect(reorderThreshold({ consumedBase: 10, windowDays: 0, leadDays: 2, safetyDays: 1 })).toBeNull();
  });
  it('has market defaults and feeds the stock status', () => {
    expect(DEFAULT_LEAD_DAYS).toBe(2);
    expect(DEFAULT_SAFETY_DAYS).toBe(1);
    expect(stockStatus(100, 150)).toBe('low');
  });
});
