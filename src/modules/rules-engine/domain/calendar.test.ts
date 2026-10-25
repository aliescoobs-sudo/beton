import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  forecastDates,
  isWorkingDay,
  NO_HOLIDAYS,
  onOrAfterWorkingDay,
  parseHolidays,
  weekday,
} from './calendar';

describe('calendar (working days Monday to Saturday)', () => {
  it('finds the weekday of a date', () => {
    expect(weekday('2026-11-01')).toBe(0); // Sunday
    expect(weekday('2026-11-02')).toBe(1);
    expect(weekday('2026-11-07')).toBe(6);
  });

  it('Sunday and holidays are not working days, Saturday is', () => {
    const cal = parseHolidays('2026-11-06');
    expect(isWorkingDay('2026-11-01', cal)).toBe(false);
    expect(isWorkingDay('2026-11-07', cal)).toBe(true);
    expect(isWorkingDay('2026-11-06', cal)).toBe(false);
  });

  it('moves a day off to the next working day and leaves a working day alone', () => {
    expect(onOrAfterWorkingDay('2026-11-01', NO_HOLIDAYS)).toBe('2026-11-02');
    expect(onOrAfterWorkingDay('2026-11-03', NO_HOLIDAYS)).toBe('2026-11-03');
  });

  it('adds working days across a Sunday and a holiday', () => {
    expect(addWorkingDays('2026-11-07', 1, NO_HOLIDAYS)).toBe('2026-11-09');
    expect(addWorkingDays('2026-11-05', 2, parseHolidays('2026-11-06'))).toBe('2026-11-09');
    expect(addWorkingDays('2026-11-02', 0, NO_HOLIDAYS)).toBe('2026-11-02');
    expect(addWorkingDays('2026-11-01', 0, NO_HOLIDAYS)).toBe('2026-11-02');
  });

  it('refuses a negative or fractional count', () => {
    expect(() => addWorkingDays('2026-11-02', -1, NO_HOLIDAYS)).toThrow(RangeError);
    expect(() => addWorkingDays('2026-11-02', 1.5, NO_HOLIDAYS)).toThrow(RangeError);
  });

  it('lists today then the next working days, today being a Sunday included', () => {
    expect(forecastDates('2026-11-01', 3, NO_HOLIDAYS)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(forecastDates('2026-11-06', 2, NO_HOLIDAYS)).toEqual(['2026-11-06', '2026-11-07', '2026-11-09']);
  });

  it('ignores what is not a real date in the holidays parameter', () => {
    expect([...parseHolidays('2026-11-06, nope, 2026-02-30').holidays]).toEqual(['2026-11-06']);
    expect(parseHolidays('').holidays.size).toBe(0);
  });
});
