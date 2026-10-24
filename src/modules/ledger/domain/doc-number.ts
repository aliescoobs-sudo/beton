/** The numbered documents (orders, purchases, invoices, delivery notes); the counter is per (prefix, year) and restarts at 1 each year. */
export const DOC_PREFIXES = ['CMD', 'ACH', 'FA', 'BL'] as const;
export type DocPrefix = (typeof DOC_PREFIXES)[number];

/** Digits of the running number (CMD-2026-00001); a wider number is never truncated. */
export const DOC_NUMBER_WIDTH = 5;

/** Same text as public.next_doc_number() builds in SQL (an integration test checks the two agree). */
export function formatDocNumber(
  prefix: DocPrefix,
  year: number,
  n: number,
  width = DOC_NUMBER_WIDTH,
): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2999)
    throw new RangeError(`Not a usable year: ${year}`);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Not a usable document number: ${n}`);
  return `${prefix}-${year}-${String(n).padStart(width, '0')}`;
}

/** The numbering year of a document is the year of its business date (never the server's calendar year). */
export function docYearOf(businessDate: string): number {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(businessDate);
  if (!match) throw new RangeError(`Not a business date: ${businessDate}`);
  return Number(match[1]);
}
