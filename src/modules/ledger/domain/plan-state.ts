/** The state of one payment-plan item, derived from what covers it and the calendar (never stored). */
export const ITEM_STATES = ['pending', 'partially_covered', 'covered', 'overdue', 'cancelled'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/**
 * `overdue` is a due date before today with the item not fully covered (a partly covered item is still overdue); a
 * cancelled item (its order was reversed) stays `cancelled`. Business dates compare as text.
 */
export function itemState(item: {
  amountCentimes: number;
  coveredCentimes: number;
  dueDate: string;
  today: string;
  cancelled?: boolean;
}): ItemState {
  if (item.cancelled) return 'cancelled';
  if (item.coveredCentimes >= item.amountCentimes) return 'covered';
  if (item.dueDate < item.today) return 'overdue';
  return item.coveredCentimes > 0 ? 'partially_covered' : 'pending';
}
