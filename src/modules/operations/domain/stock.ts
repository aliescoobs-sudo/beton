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
