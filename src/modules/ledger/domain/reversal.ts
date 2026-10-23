import { isRealDate } from './dates';

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to` (both business dates); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  if (!isRealDate(from) || !isRealDate(to)) throw new RangeError(`Not dates: ${from}, ${to}`);
  const at = (d: string) => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
}

/**
 * An entry older than the reversal window (parameter `reversal_window_days`) can only be reversed by a role holding
 * `ledger.reverse_old`; inside the window `ledger.reverse` is enough (AC-LED-17). Today only the owner holds both
 * (DECISIONS 81), but the rule stays in the service so the permission lists can change without touching it.
 */
export function needsOldEntryPermission(entryDate: string, today: string, windowDays: number): boolean {
  return daysBetween(entryDate, today) > windowDays;
}
