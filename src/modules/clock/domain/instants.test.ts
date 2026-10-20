import { describe, expect, it } from 'vitest';
import type { BusinessDate } from './business-date';
import { casablancaInstant, jobInstantsBetween } from './instants';

const day = (d: string) => d as BusinessDate;
const jobs = [
  { jobKey: 'morning', time: '06:30' },
  { jobKey: 'brief', time: '07:00' },
  { jobKey: 'close', time: '20:00' },
];

describe('casablancaInstant', () => {
  it('is UTC+1 in normal time', () => {
    expect(casablancaInstant(day('2026-07-01'), '07:00').toISOString()).toBe('2026-07-01T06:00:00.000Z');
  });

  it('throws on an impossible date or time instead of rolling over', () => {
    expect(() => casablancaInstant(day('2026-02-31'), '07:00')).toThrow(RangeError);
    expect(() => casablancaInstant(day('2026-07-01'), '25:00')).toThrow(RangeError);
  });

  it('is UTC+0 during Ramadan', () => {
    expect(casablancaInstant(day('2026-03-02'), '07:00').toISOString()).toBe('2026-03-02T07:00:00.000Z');
  });
});

describe('jobInstantsBetween', () => {
  it('lists each crossed day once, chronologically, excluding `from` and including `to`', () => {
    const from = casablancaInstant(day('2026-11-23'), '07:00');
    const to = casablancaInstant(day('2026-11-26'), '07:00');
    const list = jobInstantsBetween(from, to, jobs).map((i) => `${i.businessDate} ${i.jobKey}`);
    expect(list).toEqual([
      '2026-11-23 close',
      '2026-11-24 morning',
      '2026-11-24 brief',
      '2026-11-24 close',
      '2026-11-25 morning',
      '2026-11-25 brief',
      '2026-11-25 close',
      '2026-11-26 morning',
      '2026-11-26 brief',
    ]);
  });

  it('is empty when no job instant lies in the interval', () => {
    const from = casablancaInstant(day('2026-11-23'), '08:00');
    const to = casablancaInstant(day('2026-11-23'), '09:00');
    expect(jobInstantsBetween(from, to, jobs)).toEqual([]);
  });

  it('keeps catalogue order for jobs at the same instant', () => {
    const from = casablancaInstant(day('2026-11-23'), '00:00');
    const to = casablancaInstant(day('2026-11-23'), '23:00');
    const same = [
      { jobKey: 'a', time: '10:00' },
      { jobKey: 'b', time: '10:00' },
    ];
    expect(jobInstantsBetween(from, to, same).map((i) => i.jobKey)).toEqual(['a', 'b']);
  });
});
