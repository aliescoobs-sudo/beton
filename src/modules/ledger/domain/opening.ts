import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from './dates';

const openingSchema = z.object({ openingDate: z.string().refine(isRealDate) });
const partySchema = z
  .object({
    clientId: z.uuid().nullish(),
    supplierId: z.uuid().nullish(),
    amountCentimes: z.number().int().positive().safe(),
    reference: z
      .string()
      .transform((v) => v.trim().replace(/\s+/g, ' '))
      .pipe(z.string().min(1).max(200))
      .nullish(),
  })
  .refine((v) => Boolean(v.clientId) !== Boolean(v.supplierId));

export type OpeningInput = z.infer<typeof openingSchema>;
export type PartyOpeningInput = z.infer<typeof partySchema>;

export function parseOpeningInput(input: unknown): Result<OpeningInput, 'INVALID'> {
  const p = openingSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
}
export function parsePartyOpeningInput(input: unknown): Result<PartyOpeningInput, 'INVALID'> {
  const p = partySchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
}
