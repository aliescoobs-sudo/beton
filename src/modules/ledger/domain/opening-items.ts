// The opening position read as per-invoice open items (T19c B1, D245/D246). Pure integer-centime arithmetic, no I/O.
// A party has EITHER per-invoice items OR one opening line ("aging unknown"); when its items add up to less than the line, the difference is shown
// as ONE "no detail" remainder (never the same debt twice). Payments that no plan item took (the unallocated credit) are applied to the opening
// items oldest due date first (FIFO), then to the remainder; the order of the application is the only rule and it is the same on every screen.

export interface OpeningItem {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  balanceCentimes: number;
}

export interface OpenEntry {
  /** null = no due date known (a party's single opening line or the remainder of one). */
  dueDate: string | null;
  openCentimes: number;
  /** Where the entry comes from, for the statement and the audit of a total. */
  origin: 'opening_item' | 'opening_line' | 'plan_item';
  invoiceNumber?: string;
}

export interface OpeningSplit {
  /** One entry per item that still has a balance after the credit, oldest due first. */
  items: OpenEntry[];
  /** The part of the opening line with no per-invoice detail, after the credit (0 when the items cover the line). */
  remainderCentimes: number;
  /** What is left of the credit once every opening entry is covered. */
  creditLeftCentimes: number;
}

const byDue = (a: OpeningItem, b: OpeningItem) =>
  a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber);

/**
 * Splits a party's opening line into its per-invoice items and the remainder, then applies the unallocated credit FIFO.
 * `lineCentimes` is the party's opening line; items that add up to more than the line are a data error and the call refuses (the database door refuses them too).
 */
export function splitOpening(
  lineCentimes: number,
  items: readonly OpeningItem[],
  creditCentimes: number,
): OpeningSplit {
  const total = items.reduce((s, i) => s + i.balanceCentimes, 0);
  if (total > lineCentimes) throw new Error('opening items add up to more than the opening line');
  let credit = Math.max(0, creditCentimes);
  const open: OpenEntry[] = [];
  for (const i of [...items].sort(byDue)) {
    const used = Math.min(credit, i.balanceCentimes);
    credit -= used;
    if (i.balanceCentimes - used > 0)
      open.push({
        dueDate: i.dueDate,
        openCentimes: i.balanceCentimes - used,
        origin: 'opening_item',
        invoiceNumber: i.invoiceNumber,
      });
  }
  const remainder = lineCentimes - total;
  const usedOnRemainder = Math.min(credit, remainder);
  credit -= usedOnRemainder;
  return { items: open, remainderCentimes: remainder - usedOnRemainder, creditLeftCentimes: credit };
}

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus' | 'unknown';
export const AGING_BUCKETS: readonly AgingBucket[] = [
  'current',
  'd1_30',
  'd31_60',
  'd61_90',
  'd90plus',
  'unknown',
];

/** Whole days between two YYYY-MM-DD dates (b - a), on the calendar (no time zone, no DST). */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** current = not past due (due today or later); 1-30, 31-60, 61-90, 90+ = days PAST the due date; unknown = no due date. */
export function bucketOf(dueDate: string | null, today: string): AgingBucket {
  if (dueDate === null) return 'unknown';
  const late = daysBetween(dueDate, today);
  if (late <= 0) return 'current';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'd90plus';
}

export type AgingRow = Record<AgingBucket, number> & { total: number };

export function emptyAging(): AgingRow {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, unknown: 0, total: 0 };
}

/** The buckets of one party's open entries; the total is always the sum of the buckets. */
export function ageEntries(entries: readonly OpenEntry[], today: string): AgingRow {
  const row = emptyAging();
  for (const e of entries) {
    if (e.openCentimes <= 0) continue;
    row[bucketOf(e.dueDate, today)] += e.openCentimes;
    row.total += e.openCentimes;
  }
  return row;
}

export function addAging(a: AgingRow, b: AgingRow): AgingRow {
  const out = emptyAging();
  for (const k of [...AGING_BUCKETS, 'total'] as const) out[k] = a[k] + b[k];
  return out;
}
