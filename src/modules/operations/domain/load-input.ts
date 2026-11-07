import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from '@/modules/ledger';

// A real calendar date: 2026-02-30 has the shape of a date and is refused here, not by the database.
const dateText = z.string().refine(isRealDate, 'date');

const loadSchema = z.object({
  orderId: z.uuid(),
  truckId: z.uuid(),
  // Litres; when absent the load is the smaller of what is left to deliver and the truck's capacity.
  volumeL: z.number().int().min(1).max(30_000).nullish(),
});
const returnSchema = z.object({
  deliveryId: z.uuid(),
  returnedOn: dateText,
  returnedVolumeL: z.number().int().min(0).max(30_000).default(0),
});
const cancelSchema = z.object({
  deliveryId: z.uuid(),
  reason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

const dispatchSchema = z.object({
  date: dateText,
  rotations: z
    .array(
      z.object({
        orderId: z.uuid(),
        truckId: z.uuid(),
        driverId: z.uuid().nullish(),
        volumeL: z.number().int().min(1).max(30_000),
        /** Why the driver is not the truck's default (required then, ignored otherwise). */
        overrideReason: z
          .string()
          .transform((v) => v.trim().replace(/\s+/g, ' '))
          .pipe(z.string().min(1).max(300))
          .nullish(),
      }),
    )
    .min(1)
    .max(200),
  /** The reason of an explicit override when the plan double-books a driver or a truck (R14-01); absent: such a plan is refused. */
  overlapReason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().max(300))
    .nullish(),
});
const driverSchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(80)),
});

const openingSchema = z.object({
  componentId: z.uuid(),
  // Integer base units (g, mL or L), positive: a component with nothing in stock needs no opening row.
  qtyBase: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  date: dateText,
});
const receiptSchema = z.object({
  purchaseId: z.uuid(),
  /** Defaults to today in the service. */
  receivedDate: dateText.nullish(),
  /** What came in, line by line (thousandths of the purchase unit); absent: everything still expected. */
  lines: z
    .array(z.object({ lineId: z.uuid(), qtyMilli: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }))
    .min(1)
    .max(100)
    .nullish(),
  /** The owner's confirmation that a line goes past its ordered quantity. */
  confirmExcess: z.boolean().nullish(),
});
const thresholdSchema = z.object({
  componentId: z.uuid(),
  lowQtyBase: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type ThresholdInput = z.infer<typeof thresholdSchema>;
export type OpeningStockInput = z.infer<typeof openingSchema>;
export type DispatchInput = z.infer<typeof dispatchSchema>;
export type DriverInput = z.infer<typeof driverSchema>;
export type LoadInput = z.infer<typeof loadSchema>;
export type BlReturnInput = z.infer<typeof returnSchema>;
export type CancelLoadInput = z.infer<typeof cancelSchema>;

const parse =
  <T extends z.ZodType>(schema: T) =>
  (input: unknown): Result<z.infer<T>, 'INVALID'> => {
    const p = schema.safeParse(input);
    return p.success ? ok(p.data) : err('INVALID');
  };
export const parseDispatchInput = parse(dispatchSchema);
export const parseDriverInput = parse(driverSchema);
export const parseLoadInput = parse(loadSchema);
export const parseBlReturnInput = parse(returnSchema);
export const parseCancelLoadInput = parse(cancelSchema);
export const parseOpeningStockInput = parse(openingSchema);
export const parseReceiptInput = parse(receiptSchema);
export const parseThresholdInput = parse(thresholdSchema);

const fuelFillSchema = z.object({
  truckId: z.uuid(),
  filledOn: dateText,
  /** Litres typed by a person ("180", "180,5"): at most three decimals, converted to millilitres by the parser. */
  litres: z.string().regex(/^\d{1,4}(?:[.,]\d{1,3})?$/),
  odometerKm: z.number().int().min(0).max(5_000_000).nullish(),
  source: z.enum(['tank', 'station']).default('tank'),
});
const fuelPurchaseSchema = z.object({
  purchasedOn: dateText,
  litres: z.string().regex(/^\d{1,6}(?:[.,]\d{1,3})?$/),
  /** The total paid in MAD, typed by a person ("1 250,50"). */
  totalMad: z.string().min(1).max(20),
  supplierId: z.uuid().nullish(),
});
const lossSchema = z.object({
  deliveryId: z.uuid(),
  /** Litres of concrete lost; absent: the whole load. */
  volumeL: z.number().int().min(1).max(30_000).nullish(),
  reason: z.enum(['rejected_by_client', 'returned_unused', 'too_old', 'quality', 'other']),
  note: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().max(300))
    .nullish(),
});
export type FuelFillInput = z.infer<typeof fuelFillSchema>;
export type FuelPurchaseInput = z.infer<typeof fuelPurchaseSchema>;
export type LossInput = z.infer<typeof lossSchema>;
export const LOSS_REASONS = ['rejected_by_client', 'returned_unused', 'too_old', 'quality', 'other'] as const;
export const parseFuelFillInput = parse(fuelFillSchema);
export const parseFuelPurchaseInput = parse(fuelPurchaseSchema);
export const parseLossInput = parse(lossSchema);

/** "180,5" → 180 500 (millilitres): exact on the text, never a float. */
export function litresToMl(text: string): number {
  const [whole, frac = ''] = text.trim().replace(',', '.').split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}
