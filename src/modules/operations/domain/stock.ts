/** The stock of a component is the sum of its movements (opening, deliveries, receipts, counts, reversals). */
export const stockLevel = (movements: readonly number[]): number => movements.reduce((sum, m) => sum + m, 0);

export type StockStatus = 'ok' | 'low' | 'short';

/** `short` below zero (the plant has loaded more than it knew it had), `low` below the threshold, else `ok`. */
export function stockStatus(level: number, lowThreshold: number | null): StockStatus {
  if (level < 0) return 'short';
  if (lowThreshold !== null && level < lowThreshold) return 'low';
  return 'ok';
}

/** Volume of an order still to deliver, in litres (never negative). */
export const remainingVolume = (orderVolumeL: number, loadedL: readonly number[]): number =>
  Math.max(0, orderVolumeL - loadedL.reduce((sum, v) => sum + v, 0));

/** Market defaults until the lead time of a component is set and the history of months is imported (REQUIREMENTS-V1 §6, 🟡). */
export const DEFAULT_LEAD_DAYS = 2;
export const DEFAULT_SAFETY_DAYS = 1;

/**
 * The reorder threshold of a component at a plant: what is consumed during the lead time of its supplier plus a safety
 * margin, i.e. ceil(average daily consumption × (lead days + safety days)). Integer base units, deterministic.
 * `consumedBase` is the net quantity used over `windowDays` days (positive). No consumption yet means no threshold (null):
 * the plant sets one by hand until the history is there.
 */
export function reorderThreshold(input: {
  consumedBase: number;
  windowDays: number;
  leadDays: number;
  safetyDays: number;
}): number | null {
  const { consumedBase, windowDays, leadDays, safetyDays } = input;
  if (windowDays <= 0 || consumedBase <= 0) return null;
  // ceil(consumed × days / window) in integers: no floating-point average.
  const days = Math.max(0, leadDays) + Math.max(0, safetyDays);
  return Math.ceil((consumedBase * days) / windowDays);
}
