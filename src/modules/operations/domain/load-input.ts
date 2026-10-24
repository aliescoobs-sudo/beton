import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';

const dateText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

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
