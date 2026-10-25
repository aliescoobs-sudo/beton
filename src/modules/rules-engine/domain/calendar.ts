import { addDaysIso, isRealDate } from '@/modules/ledger';

/** Working days are Monday to Saturday; the holidays are a configurable list of dates (SPEC A5). */
export interface Calendar {
  holidays: ReadonlySet<string>;
}

export const NO_HOLIDAYS: Calendar = { holidays: new Set() };

const SUNDAY = 0;

/** 0 = Sunday … 6 = Saturday, of a business date (UTC midnight, so no time zone can shift it). */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWorkingDay = (date: string, calendar: Calendar): boolean =>
  weekday(date) !== SUNDAY && !calendar.holidays.has(date);

/** The date itself when it is a working day, else the next working day. */
export function onOrAfterWorkingDay(date: string, calendar: Calendar): string {
  let d = date;
  while (!isWorkingDay(d, calendar)) d = addDaysIso(d, 1);
  return d;
}

/** `count` working days after `date` (0 = the date itself, or the next working day when it is not one). */
export function addWorkingDays(date: string, count: number, calendar: Calendar): string {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`Not a working-day count: ${count}`);
  let d = onOrAfterWorkingDay(date, calendar);
  for (let left = count; left > 0; left--) d = onOrAfterWorkingDay(addDaysIso(d, 1), calendar);
  return d;
}

/**
 * The days of a forecast: today (always, even on a day off: the position is today's) followed by the next `count`
 * working days.
 */
export function forecastDates(today: string, count: number, calendar: Calendar): string[] {
  const dates = [today];
  let d = today;
  for (let i = 0; i < count; i++) {
    d = onOrAfterWorkingDay(addDaysIso(d, 1), calendar);
    dates.push(d);
  }
  return dates;
}

/** Parses the `holidays` parameter ("2026-11-06, 2026-11-18"); anything that is not a real date is ignored. */
export function parseHolidays(text: string): Calendar {
  const dates = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(isRealDate);
  return { holidays: new Set(dates) };
}
