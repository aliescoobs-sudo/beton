import { z } from 'zod';
import { addCentimes, centimes, type Centimes, mulDivRound, sumCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { addDaysIso, isRealDate } from './dates';
import { DEFAULT_PAYMENT_DAYS, MAX_PAYMENT_DAYS } from './legal';
import { daysBetween } from './reversal';

/** Litres per m³: the price is per m³, a load is in litres. A unit divisor, not a rate. */
const LITRES_PER_M3 = 1000;
const BP_DENOMINATOR = 10_000;

/**
 * Law 69-21: an invoice is issued by the end of the month in which the delivery took place. The deadline is the last day
 * of the month of the (latest) invoiced delivery; being late is a fact to flag, never a reason to refuse the invoice.
 */
export function invoiceIssueDeadline(deliveryDate: string): string {
  if (!isRealDate(deliveryDate)) throw new RangeError(`Not a date: ${deliveryDate}`);
  const [y, m] = deliveryDate.split('-').map(Number) as [number, number];
  const firstOfNext = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDaysIso(firstOfNext, -1);
}

export type InvoiceDueError = 'PAYMENT_TERM_TOO_LONG' | 'DUE_BEFORE_INVOICE';

/** The due date of an invoice: the one given, else the invoice date + 60 days; more than 120 days is refused (AC-LED-09). */
export function invoiceDueDate(
  invoiceDate: string,
  given: string | null | undefined,
): Result<string, InvoiceDueError> {
  const due = given ?? addDaysIso(invoiceDate, DEFAULT_PAYMENT_DAYS);
  if (due < invoiceDate) return err('DUE_BEFORE_INVOICE');
  if (daysBetween(invoiceDate, due) > MAX_PAYMENT_DAYS) return err('PAYMENT_TERM_TOO_LONG');
  return ok(due);
}

export interface InvoiceTotals {
  lineHt: Centimes[];
  totalHt: Centimes;
  totalVat: Centimes;
  totalTtc: Centimes;
}

/** Line = unit price per m³ × litres / 1000, rounded once; VAT on the HT total, rounded once; TTC = HT + VAT. */
export function computeInvoiceTotals(
  lines: readonly { volumeL: number; unitPriceHtCentimes: number }[],
  vatRateBp: number,
): Result<InvoiceTotals, 'INVALID_LINE' | 'INVALID_VAT_RATE'> {
  if (!Number.isSafeInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > BP_DENOMINATOR)
    return err('INVALID_VAT_RATE');
  if (lines.length === 0) return err('INVALID_LINE');
  const lineHt: Centimes[] = [];
  for (const l of lines) {
    if (!Number.isSafeInteger(l.volumeL) || l.volumeL <= 0) return err('INVALID_LINE');
    if (!Number.isSafeInteger(l.unitPriceHtCentimes) || l.unitPriceHtCentimes <= 0)
      return err('INVALID_LINE');
    lineHt.push(mulDivRound(centimes(l.unitPriceHtCentimes), l.volumeL, LITRES_PER_M3));
  }
  const totalHt = sumCentimes(lineHt);
  const totalVat = mulDivRound(totalHt, vatRateBp, BP_DENOMINATOR);
  return ok({ lineHt, totalHt, totalVat, totalTtc: addCentimes(totalHt, totalVat) });
}

const invoiceSchema = z.object({
  orderId: z.uuid(),
  /** The loads to invoice; every uninvoiced load of the order when absent. */
  deliveryIds: z.array(z.uuid()).min(1).max(200).nullish(),
  dueDate: z.string().refine(isRealDate, 'date').nullish(),
});
export type InvoiceInput = z.infer<typeof invoiceSchema>;

export function parseInvoiceInput(input: unknown): Result<InvoiceInput, 'INVALID'> {
  const parsed = invoiceSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
