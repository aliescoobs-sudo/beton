import { z } from 'zod';
import { addCentimes, centimes, type Centimes, mulDivRound, sumCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { addDaysIso, isRealDate } from './dates';
import { daysBetween } from './reversal';
import { DEFAULT_PAYMENT_DAYS, MAX_PAYMENT_DAYS } from './legal';
import { PLAN_METHODS } from './plan';

/** Quantities are typed in thousandths of the purchase unit (2,5 t = 2500); a unit divisor, not a rate. */
const THOUSANDTHS = 1000;

const date = z.string().refine(isRealDate, 'date');
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));

const qtyMilli = z.number().int().min(1).max(1_000_000_000_000);
const price = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const stockedLine = z.object({
  componentId: z.uuid(),
  purchaseUnitId: z.uuid(),
  qtyMilli,
  unitPriceHtCentimes: price,
});
const serviceLine = z.object({
  description: text(200),
  /** Optional: a service is one unit unless said otherwise (one whole unit). */
  qtyMilli: qtyMilli.default(THOUSANDTHS),
  unitPriceHtCentimes: price,
});

const planItem = z
  .object({
    method: z.enum(PLAN_METHODS),
    dueDate: date,
    percentBp: z.number().int().min(1).max(10_000).optional(),
    amountCentimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((i) => (i.percentBp === undefined) !== (i.amountCentimes === undefined), 'one share per item');

const purchaseSchema = z.object({
  supplierId: z.uuid(),
  supplierInvoiceNo: text(60).nullish(),
  supplierInvoiceDate: date.nullish(),
  /** Defaults to the supplier invoice date (else the order date) + 60 days (law 69-21). */
  dueDate: date.nullish(),
  lines: z
    .array(z.union([stockedLine, serviceLine]))
    .min(1)
    .max(50),
  /** Defaults to one transfer on the due date for the whole amount. */
  plan: z.array(planItem).min(1).max(24).nullish(),
  /**
   * Where the payable comes from: the supplier's invoice, once approved (default; the order carries no plan), or the order itself
   * (the way it was before; plan and invoice number are then the order's).
   */
  payable: z.enum(['order', 'invoice']).nullish(),
});

export type PurchaseLineInput =
  | { componentId: string; purchaseUnitId: string; qtyMilli: number; unitPriceHtCentimes: number }
  | { description: string; qtyMilli: number; unitPriceHtCentimes: number };
export type PurchaseInput = z.infer<typeof purchaseSchema>;

export function parsePurchaseInput(input: unknown): Result<PurchaseInput, 'INVALID'> {
  const parsed = purchaseSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

export interface PurchaseTotals {
  lineHt: Centimes[];
  totalHt: Centimes;
  totalVat: Centimes;
  totalTtc: Centimes;
}

/** Line total = price × quantity (thousandths), rounded once; VAT on the HT total, rounded once; TTC = HT + VAT. */
export function computePurchaseTotals(
  lines: readonly { qtyMilli: number; unitPriceHtCentimes: number }[],
  vatRateBp: number,
): Result<PurchaseTotals, 'INVALID_LINE' | 'INVALID_VAT_RATE'> {
  if (!Number.isSafeInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) return err('INVALID_VAT_RATE');
  if (lines.length === 0) return err('INVALID_LINE');
  const lineHt: Centimes[] = [];
  for (const l of lines) {
    if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) return err('INVALID_LINE');
    if (!Number.isSafeInteger(l.unitPriceHtCentimes) || l.unitPriceHtCentimes <= 0)
      return err('INVALID_LINE');
    const ht = mulDivRound(centimes(l.unitPriceHtCentimes), l.qtyMilli, THOUSANDTHS);
    if (ht <= 0) return err('INVALID_LINE');
    lineHt.push(ht);
  }
  const totalHt = sumCentimes(lineHt);
  const totalVat = mulDivRound(totalHt, vatRateBp, 10_000);
  return ok({ lineHt, totalHt, totalVat, totalTtc: addCentimes(totalHt, totalVat) });
}

export type PurchaseDueError = 'PAYMENT_TERM_TOO_LONG' | 'DUE_BEFORE_ORDER';

/**
 * The due date of a purchase (law 69-21, R24): the one given, else the supplier's invoice date (else the order date) plus
 * 60 days. More than 120 days after that base is refused; a date before the order is refused too.
 */
export function purchaseDueDate(
  orderDate: string,
  supplierInvoiceDate: string | null | undefined,
  given: string | null | undefined,
): Result<string, PurchaseDueError> {
  const base = supplierInvoiceDate ?? orderDate;
  const due = given ?? addDaysIso(base, DEFAULT_PAYMENT_DAYS);
  if (due < orderDate) return err('DUE_BEFORE_ORDER');
  if (daysBetween(base, due) > MAX_PAYMENT_DAYS) return err('PAYMENT_TERM_TOO_LONG');
  return ok(due);
}
