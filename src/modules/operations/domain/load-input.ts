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
});
const thresholdSchema = z.object({
  componentId: z.uuid(),
  lowQtyBase: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type ThresholdInput = z.infer<typeof thresholdSchema>;
export type OpeningStockInput = z.infer<typeof openingSchema>;
export type LoadInput = z.infer<typeof loadSchema>;
export type BlReturnInput = z.infer<typeof returnSchema>;
export type CancelLoadInput = z.infer<typeof cancelSchema>;

const parse =
  <T extends z.ZodType>(schema: T) =>
  (input: unknown): Result<z.infer<T>, 'INVALID'> => {
    const p = schema.safeParse(input);
    return p.success ? ok(p.data) : err('INVALID');
  };
export const parseLoadInput = parse(loadSchema);
export const parseBlReturnInput = parse(returnSchema);
export const parseCancelLoadInput = parse(cancelSchema);
export const parseOpeningStockInput = parse(openingSchema);
export const parseReceiptInput = parse(receiptSchema);
export const parseThresholdInput = parse(thresholdSchema);
