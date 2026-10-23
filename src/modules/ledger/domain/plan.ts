import { addCentimes, centimes, type Centimes, mulDivRound, subCentimes, sumCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { isIsoDate } from './instrument-dates';

/** How we expect to be paid (a plan item); an instrument is what actually arrives (plan decision 10). */
export const PLAN_METHODS = ['cash', 'cheque', 'lcn', 'transfer', 'advance', 'installment'] as const;
export type PlanMethod = (typeof PLAN_METHODS)[number];

/** A share is a percentage in basis points (10 000 = 100 %) or a fixed amount; one plan uses a single kind. */
export type PlanShare = { percentBp: number } | { amount: Centimes };

export interface PlanItemInput {
  method: PlanMethod;
  dueDate: string;
  share: PlanShare;
}

export interface PlanItem {
  method: PlanMethod;
  dueDate: string;
  amount: Centimes;
}

export type PlanError =
  'EMPTY_PLAN' | 'INVALID_ITEM' | 'MIXED_SHARES' | 'PERCENT_SUM_NOT_100' | 'SUM_MISMATCH' | 'INVALID_TOTAL';

const FULL = 10_000;

/**
 * Splits a document total (TTC) into payment-plan items. Percentages are applied with one rounding each (half away
 * from zero) and the LAST item absorbs the rounding, so Σ items = total exactly (AC-LED-01, AC-LED-02). Fixed amounts
 * must already add up to the total; a plan that does not is an error, never silently adjusted.
 */
export function splitPlan(
  totalTtc: Centimes,
  items: readonly PlanItemInput[],
): Result<PlanItem[], PlanError> {
  if (!Number.isSafeInteger(totalTtc) || totalTtc <= 0) return err('INVALID_TOTAL');
  if (items.length === 0) return err('EMPTY_PLAN');
  if (items.some((i) => !PLAN_METHODS.includes(i.method) || !isIsoDate(i.dueDate)))
    return err('INVALID_ITEM');

  const percentCount = items.filter((i) => 'percentBp' in i.share).length;
  if (percentCount > 0 && percentCount < items.length) return err('MIXED_SHARES');

  if (percentCount === 0) {
    const amounts = items.map((i) => (i.share as { amount: Centimes }).amount);
    if (amounts.some((a) => !Number.isSafeInteger(a) || a <= 0)) return err('INVALID_ITEM');
    if (sumCentimes(amounts) !== totalTtc) return err('SUM_MISMATCH');
    return ok(
      items.map((i, n) => ({ method: i.method, dueDate: i.dueDate, amount: amounts[n] as Centimes })),
    );
  }

  const bps = items.map((i) => (i.share as { percentBp: number }).percentBp);
  if (bps.some((bp) => !Number.isSafeInteger(bp) || bp <= 0)) return err('INVALID_ITEM');
  if (bps.reduce((a, b) => a + b, 0) !== FULL) return err('PERCENT_SUM_NOT_100');

  const out: PlanItem[] = [];
  let allocated = centimes(0);
  items.forEach((item, n) => {
    const last = n === items.length - 1;
    const amount = last ? subCentimes(totalTtc, allocated) : mulDivRound(totalTtc, bps[n] as number, FULL);
    allocated = addCentimes(allocated, amount);
    out.push({ method: item.method, dueDate: item.dueDate, amount });
  });
  // A tiny share of a tiny total can round to 0: refuse rather than store a null item.
  return out.some((i) => i.amount <= 0) ? err('INVALID_ITEM') : ok(out);
}
