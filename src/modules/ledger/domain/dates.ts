import { isIsoDate } from './instrument-dates';

const DAY_MS = 86_400_000;

/** A real calendar date (not only date-shaped): 2026-02-30 is refused. */
export function isRealDate(value: string): boolean {
  if (!isIsoDate(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Calendar arithmetic on a business date string (UTC midnights, so no time zone or DST can shift a day). */
export function addDaysIso(date: string, days: number): string {
  if (!isRealDate(date)) throw new RangeError(`Not a date: ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}
