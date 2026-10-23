import { describe, expect, it } from 'vitest';
import { simDays } from './sim-days';

describe('simDays', () => {
  it('lists past days, today and future days in order, across a month end', () => {
    const days = simDays('2026-11-02', 3, 2);
    expect(days.map((d) => d.date)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(days.map((d) => d.state)).toEqual(['past', 'past', 'past', 'today', 'future', 'future']);
    expect(days.map((d) => d.day)).toEqual([30, 31, 1, 2, 3, 4]);
  });

  it('has exactly one today, and handles a leap day', () => {
    const days = simDays('2028-03-01');
    expect(days.filter((d) => d.state === 'today')).toHaveLength(1);
    expect(days.map((d) => d.date)).toContain('2028-02-29');
  });
});
