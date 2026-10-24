import { describe, expect, it } from 'vitest';
import { itemState } from './plan-state';

const base = { amountCentimes: 100_000, coveredCentimes: 0, dueDate: '2026-06-10', today: '2026-06-01' };

describe('itemState', () => {
  it('pending until something covers it, partially covered then covered', () => {
    expect(itemState(base)).toBe('pending');
    expect(itemState({ ...base, coveredCentimes: 40_000 })).toBe('partially_covered');
    expect(itemState({ ...base, coveredCentimes: 100_000 })).toBe('covered');
    expect(itemState({ ...base, coveredCentimes: 100_001 })).toBe('covered');
  });

  it('overdue when the due date has passed and it is not covered, partial cover included', () => {
    expect(itemState({ ...base, today: '2026-06-11' })).toBe('overdue');
    expect(itemState({ ...base, today: '2026-06-11', coveredCentimes: 99_999 })).toBe('overdue');
    expect(itemState({ ...base, today: '2026-06-11', coveredCentimes: 100_000 })).toBe('covered');
  });

  it('is not overdue on the due date itself', () => {
    expect(itemState({ ...base, today: '2026-06-10' })).toBe('pending');
  });

  it('a cancelled item stays cancelled whatever covers it or whenever it fell due', () => {
    expect(itemState({ ...base, cancelled: true, today: '2027-01-01', coveredCentimes: 100_000 })).toBe(
      'cancelled',
    );
  });
});
