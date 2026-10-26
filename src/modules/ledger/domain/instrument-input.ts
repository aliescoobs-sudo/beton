import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from './dates';
import { INSTRUMENT_METHODS } from './instrument';

const date = z.string().refine(isRealDate);
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));

/** What a person types when a payment arrives or leaves; paper needs a number and the date written on it. */
const paper = z.object({
  method: z.enum(INSTRUMENT_METHODS),
  amountCentimes: z.number().int().positive().safe(),
  number: text(40).nullish(),
  bank: text(80).nullish(),
  writtenDate: date.nullish(),
});

function normalise<T extends z.infer<typeof paper>>(v: T) {
  const isPaper = v.method === 'cheque' || v.method === 'lcn';
  return {
    ...v,
    number: v.method === 'cash' ? null : (v.number ?? null),
    bank: v.method === 'cash' ? null : (v.bank ?? null),
    writtenDate: isPaper ? (v.writtenDate ?? null) : null,
  };
}
const complete = (v: ReturnType<typeof normalise>) =>
  v.method === 'cheque' || v.method === 'lcn' ? v.number !== null && v.writtenDate !== null : true;

const ORDER_CODE = /^CMD-[0-9]{4}-[0-9]{5,}$/;
const receiveSchema = paper
  .extend({
    clientId: z.uuid(),
    // The order this payment is for: the oldest open items of that order are covered (office cannot read items).
    orderCode: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(ORDER_CODE))
      .nullish(),
    // No order named: spread the payment over the client's open invoices, oldest due date first.
    allocateToClient: z.boolean().nullish(),
  })
  .transform(normalise)
  .refine(complete);
const PURCHASE_CODE = /^ACH-[0-9]{4}-[0-9]{5,}$/;
const issueSchema = paper
  .extend({
    supplierId: z.uuid(),
    // The purchase this payment is for: the oldest open items of that purchase are covered (office cannot read items).
    purchaseCode: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(PURCHASE_CODE))
      .nullish(),
  })
  .transform(normalise)
  .refine(complete);

export type ReceiveInstrumentInput = z.infer<typeof receiveSchema>;
export type IssueInstrumentInput = z.infer<typeof issueSchema>;

export function parseReceiveInput(input: unknown): Result<ReceiveInstrumentInput, 'INVALID'> {
  const parsed = receiveSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
export function parseIssueInput(input: unknown): Result<IssueInstrumentInput, 'INVALID'> {
  const parsed = issueSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

const clearSchema = z.object({ instrumentId: z.uuid(), accountId: z.uuid(), date });
const cancelSchema = z.object({ instrumentId: z.uuid(), reason: text(500), date });
const reverseSchema = z.object({ movementId: z.uuid(), reason: text(500) });

export type ClearInstrumentInput = z.infer<typeof clearSchema>;
export type CancelInstrumentInput = z.infer<typeof cancelSchema>;
export type ReverseMovementInput = z.infer<typeof reverseSchema>;

export const parseClearInput = (input: unknown): Result<ClearInstrumentInput, 'INVALID'> => {
  const p = clearSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};
export const parseCancelInput = (input: unknown): Result<CancelInstrumentInput, 'INVALID'> => {
  const p = cancelSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};
export const parseReverseInput = (input: unknown): Result<ReverseMovementInput, 'INVALID'> => {
  const p = reverseSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};

const allocateSchema = z.object({
  instrumentId: z.uuid(),
  itemId: z.uuid(),
  amountCentimes: z.number().int().positive().safe(),
});
const unallocateSchema = z.object({ allocationId: z.uuid(), reason: text(500) });
export type AllocateInput = z.infer<typeof allocateSchema>;
export type UnallocateInput = z.infer<typeof unallocateSchema>;
export const parseAllocateInput = (input: unknown): Result<AllocateInput, 'INVALID'> => {
  const p = allocateSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};
export const parseUnallocateInput = (input: unknown): Result<UnallocateInput, 'INVALID'> => {
  const p = unallocateSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};

const depositSchema = z.object({
  instrumentIds: z
    .array(z.uuid())
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length),
  accountId: z.uuid(),
  date,
});
export type DepositInput = z.infer<typeof depositSchema>;
export const parseDepositInput = (input: unknown): Result<DepositInput, 'INVALID'> => {
  const p = depositSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};

const bounceSchema = z.object({
  instrumentId: z.uuid(),
  date,
  // The bank's fee for the bounce, when the owner knows it (centimes, whole).
  feeCentimes: z.number().int().positive().safe().nullish(),
});
const regularizeSchema = z.object({ instrumentId: z.uuid(), coveringInstrumentId: z.uuid(), date });
const disputeSchema = z.object({ instrumentId: z.uuid(), reason: text(500), date });
export type BounceInput = z.infer<typeof bounceSchema>;
export type RegularizeInput = z.infer<typeof regularizeSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export const parseBounceInput = (input: unknown): Result<BounceInput, 'INVALID'> => {
  const p = bounceSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};
export const parseRegularizeInput = (input: unknown): Result<RegularizeInput, 'INVALID'> => {
  const p = regularizeSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};
export const parseDisputeInput = (input: unknown): Result<DisputeInput, 'INVALID'> => {
  const p = disputeSchema.safeParse(input);
  return p.success ? ok(p.data) : err('INVALID');
};
