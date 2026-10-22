import type { Truck, TruckStatusEntry } from './truck';

const covers = (entry: TruckStatusEntry, date: string) =>
  entry.fromDate <= date && (entry.toDate === null || date < entry.toDate);

/**
 * Whether a truck can be planned on a business date (YYYY-MM-DD). An archived truck never can. Otherwise the log
 * decides: entries cover [fromDate, toDate), the latest one logged that covers the day wins (so an `available`
 * entry ends a breakdown early), and a day no entry covers is available.
 */
export function isTruckAvailable(
  truck: Pick<Truck, 'status'>,
  date: string,
  log: readonly TruckStatusEntry[],
): boolean {
  if (truck.status === 'archived') return false;
  let decisive: TruckStatusEntry | undefined;
  for (const entry of log) {
    if (!covers(entry, date)) continue;
    if (
      !decisive ||
      entry.createdAt > decisive.createdAt ||
      (entry.createdAt === decisive.createdAt && entry.id > decisive.id)
    ) {
      decisive = entry;
    }
  }
  return decisive === undefined || decisive.status === 'available';
}

/** The days of [from, to) (YYYY-MM-DD, `to` excluded), in order. */
export function datesInRange(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t < end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
