import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from './dates';
import { PLAN_METHODS } from './plan';

/** The two discharge methods of D236: mixer alone (chute) or mixer plus pump truck. */
export const DISCHARGE_METHODS = ['GOULOTTE', 'POMPE'] as const;
export type DischargeMethod = (typeof DISCHARGE_METHODS)[number];

const date = z.string().refine(isRealDate, 'date');
const customItem = z
  .object({
    method: z.enum(PLAN_METHODS),
    dueDate: date,
    percentBp: z.number().int().min(1).max(10_000).optional(),
    amountCentimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((i) => (i.percentBp === undefined) !== (i.amountCentimes === undefined), 'one share per item');

const priceOverride = z.object({
  /** Centimes HT per m³, different from the price in force; only the owner may send it (orders.price_override). */
  unitPriceHtCentimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  reason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

const orderInputSchema = z.object({
  clientId: z.uuid(),
  /** The plant that produces and books the order. Needed when more than one plant is active; a plant manager's own plant is used. */
  plantId: z.uuid().nullish(),
  siteId: z.uuid().nullable().default(null),
  zoneId: z.uuid().nullable().default(null),
  concreteTypeId: z.uuid(),
  /** D239 d: required, exactly two choices, no default. A missing or unknown method is an invalid input. */
  dischargeMethod: z.enum(DISCHARGE_METHODS),
  /** Litres: the form converts m³ with parseMilliQty (7,5 m³ → 7 500), never with a float. */
  volumeL: z.number().int().min(1).max(100_000_000),
  deliveryDate: date,
  broughtByUserId: z.uuid().nullable().default(null),
  /** T19 item 4: the client's own purchase-order number (mandatory when the client is flagged po_required: the database refuses the order without it) and the commercial of the order. */
  clientPo: z.string().trim().min(1).max(60).nullish(),
  commercial: z.string().trim().min(1).max(80).nullish(),
  priceOverride: priceOverride.nullish(),
  /** The quote this order is made from (the owner converts a quote through the order form). */
  quoteId: z.uuid().nullish(),
  plan: z.discriminatedUnion('preset', [
    z.object({ preset: z.literal('cash') }),
    z.object({ preset: z.literal('advance50') }),
    z.object({ preset: z.literal('installments3') }),
    z.object({ preset: z.literal('cheque30') }),
    z.object({ preset: z.literal('custom'), items: z.array(customItem).min(1).max(24) }),
  ]),
});

export type OrderInput = z.infer<typeof orderInputSchema>;

export function parseOrderInput(input: unknown): Result<OrderInput, 'INVALID'> {
  const parsed = orderInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
