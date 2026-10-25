import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { addDaysIso } from './dates';

/** A quote stays valid this many days unless the person says otherwise. A calendar default, not a legal term or a rate. */
export const DEFAULT_QUOTE_DAYS = 30;
const MAX_QUOTE_DAYS = 180;

const schema = z.object({
  clientId: z.uuid(),
  concreteTypeId: z.uuid(),
  /** Litres, from the form's m³ through parseMilliQty (never a float). */
  volumeL: z.number().int().min(1).max(100_000_000),
  validDays: z.number().int().min(1).max(MAX_QUOTE_DAYS).nullish(),
});
export type QuoteInput = z.infer<typeof schema>;

export function parseQuoteInput(input: unknown): Result<QuoteInput, 'INVALID'> {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

/** The last day a quote can be accepted: the quote date plus its validity. */
export const quoteValidUntil = (quoteDate: string, validDays?: number | null): string =>
  addDaysIso(quoteDate, validDays ?? DEFAULT_QUOTE_DAYS);

/** A quote can be turned into an order on or before its last day, and only once. */
export const quoteIsOpen = (
  q: { validUntil: string; convertedOrderCode: string | null },
  today: string,
): boolean => q.convertedOrderCode === null && q.validUntil >= today;
