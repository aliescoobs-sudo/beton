import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from './dates';

export const ACCOUNT_KINDS = ['cash', 'bank'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));

const accountSchema = z
  .object({
    kind: z.enum(ACCOUNT_KINDS),
    label: text(80),
    bankName: text(80).nullish(),
  })
  .transform((v) => ({
    kind: v.kind,
    label: v.label,
    bankName: v.kind === 'bank' ? (v.bankName ?? null) : null,
  }))
  .refine((v) => v.kind === 'cash' || v.bankName !== null);

export type MoneyAccountInput = z.infer<typeof accountSchema>;

export function parseMoneyAccountInput(input: unknown): Result<MoneyAccountInput, 'INVALID'> {
  const parsed = accountSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

const openingSchema = z.object({
  accountId: z.uuid(),
  asOf: z.string().refine(isRealDate),
  // A balance can be negative (an overdraft); it is a whole number of centimes.
  amountCentimes: z.number().int().safe(),
  note: text(500).nullish(),
});

export type OpeningBalanceInput = z.infer<typeof openingSchema>;

export function parseOpeningBalanceInput(input: unknown): Result<OpeningBalanceInput, 'INVALID'> {
  const parsed = openingSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
