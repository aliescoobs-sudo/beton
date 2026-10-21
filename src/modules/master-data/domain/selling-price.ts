import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { dateField } from './date-field';

export interface SellingPrice {
  id: string;
  concreteTypeId: string;
  /** null = the list price of the concrete type; otherwise a per-client override. */
  clientId: string | null;
  /** Centimes HT per m³. */
  priceHtPerM3Centimes: number;
  /** Business date (YYYY-MM-DD) from which this price applies. */
  effectiveFrom: string;
  /** Why an override was granted (required for overrides, absent on list prices). */
  reason: string | null;
}

const listPriceInputSchema = z.object({
  concreteTypeId: z.uuid(),
  // Integer centimes: the form converts MAD with parseCentimes, never with a float.
  priceHtPerM3Centimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  effectiveFrom: dateField,
});

export type ListPriceInput = z.infer<typeof listPriceInputSchema>;

export function parseListPriceInput(input: unknown): Result<ListPriceInput, 'INVALID'> {
  const parsed = listPriceInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

const overrideInputSchema = listPriceInputSchema.extend({
  clientId: z.uuid(),
  // Mandatory: a concession below the list price must say why (AC-MD-10).
  reason: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(500)),
});

export type OverrideInput = z.infer<typeof overrideInputSchema>;

export function parseOverrideInput(input: unknown): Result<OverrideInput, 'INVALID'> {
  const parsed = overrideInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

/** The version of one scope (list or one client) in force on `date`: latest effective_from not after it. */
function inForce(
  versions: readonly SellingPrice[],
  concreteTypeId: string,
  clientId: string | null,
  date: string,
): SellingPrice | undefined {
  let best: SellingPrice | undefined;
  for (const v of versions) {
    if (v.concreteTypeId !== concreteTypeId || v.clientId !== clientId || v.effectiveFrom > date) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  return best;
}

/**
 * The selling price of a concrete type for a client on a business date (SPEC-master-data §3, AC-MD-03): the client's
 * override when one is in force, else the list price. No price at all is an error, never 0.
 */
export function resolveSellingPrice(
  versions: readonly SellingPrice[],
  concreteTypeId: string,
  clientId: string | null,
  date: string,
): Result<SellingPrice, 'NO_PRICE'> {
  const override = clientId ? inForce(versions, concreteTypeId, clientId, date) : undefined;
  const found = override ?? inForce(versions, concreteTypeId, null, date);
  return found ? ok(found) : err('NO_PRICE');
}
