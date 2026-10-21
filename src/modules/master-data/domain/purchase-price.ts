import { z } from 'zod';
import { centimes, type Centimes } from '@/lib/money';
import { baseQty, costOf } from '@/lib/quantity';
import { err, ok, type Result } from '@/lib/result';
import type { RecetteLine } from './recette';

export interface PurchasePrice {
  id: string;
  componentId: string;
  supplierId: string;
  purchaseUnitId: string;
  /** Centimes HT per purchase unit. */
  priceHtCentimes: number;
  /** Business date (YYYY-MM-DD) from which this price applies. */
  effectiveFrom: string;
}

/** A price together with the factor of its purchase unit, which is all the cost computation needs. */
export type PricePoint = Pick<PurchasePrice, 'componentId' | 'priceHtCentimes' | 'effectiveFrom'> & {
  factorToBase: number;
};

const isRealDate = (value: string) => {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const purchasePriceInputSchema = z.object({
  componentId: z.uuid(),
  supplierId: z.uuid(),
  purchaseUnitId: z.uuid(),
  // Integer centimes: the form converts MAD with parseCentimes, never with a float.
  priceHtCentimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealDate),
});

export type PurchasePriceInput = z.infer<typeof purchasePriceInputSchema>;

export function parsePurchasePriceInput(input: unknown): Result<PurchasePriceInput, 'INVALID'> {
  const parsed = purchasePriceInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

/** The price of a component in force on `date`: the latest effective_from not after it. */
export function resolvePurchasePrice(
  prices: readonly PricePoint[],
  componentId: string,
  date: string,
): Result<PricePoint, 'NO_PRICE'> {
  let best: PricePoint | undefined;
  for (const price of prices) {
    if (price.componentId !== componentId || price.effectiveFrom > date) continue;
    if (!best || price.effectiveFrom > best.effectiveFrom) best = price;
  }
  return best ? ok(best) : err('NO_PRICE');
}

/**
 * Cost of the components of one m³ on `date` (SPEC-master-data §2): Σ qty × price / factor, one rounding per line
 * (half away from zero, `costOf`). Computed on demand, never stored. A component with no price on that date is an
 * error, never a zero.
 */
export function componentCostPerM3(
  lines: readonly RecetteLine[],
  prices: readonly PricePoint[],
  date: string,
): Result<Centimes, 'NO_PRICE'> {
  let total = 0;
  for (const line of lines) {
    const price = resolvePurchasePrice(prices, line.componentId, date);
    if (!price.ok) return err('NO_PRICE');
    const { priceHtCentimes, factorToBase } = price.value;
    total += costOf(baseQty(line.qtyPerM3), centimes(priceHtCentimes), factorToBase);
  }
  return ok(centimes(total));
}
