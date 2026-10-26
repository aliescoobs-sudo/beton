/** The gaps the database flags on a supplier invoice line (three-way match: order, receipts, invoice). */
export const MATCH_FLAGS = ['NOT_ON_ORDER', 'PRICE', 'QTY_OVER_RECEIVED', 'QTY_OVER_ORDERED'] as const;
export type MatchFlag = (typeof MATCH_FLAGS)[number];

export interface MatchLine {
  seq: number;
  description: string;
  /** The order line this line bills; null when the order has none (a gap). */
  purchaseLineId: string | null;
  orderedMilli: number | null;
  orderedPriceCentimes: number | null;
  /** Received through the receipts this invoice covers. */
  receivedMilli: number;
  invoicedMilli: number;
  /** Invoiced on this order line over every live invoice, this one included. */
  cumulativeMilli: number;
  invoicedPriceCentimes: number;
  flags: MatchFlag[];
}

/** Nothing flagged on any line: the invoice may be approved at once. */
export const matchIsClean = (lines: readonly MatchLine[]): boolean =>
  lines.every((l) => l.flags.length === 0);

/** How many lines carry at least one gap. */
export const gapCount = (lines: readonly MatchLine[]): number =>
  lines.filter((l) => l.flags.length > 0).length;
