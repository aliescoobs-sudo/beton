import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from './dates';

const date = z.string().refine(isRealDate, 'date');
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));

const PURCHASE_CODE = /^ACH-[0-9]{4}-[0-9]{5,}$/;

const lineSchema = z
  .object({
    /** The stocked component the line bills: the database links it to the purchase line of the same component. */
    componentId: z.uuid().nullish(),
    /** A service (transport, fuel) or a line the order does not have, described in words. */
    description: text(200).nullish(),
    /** Thousandths of the unit of the purchase line (2,5 t = 2500), as the supplier wrote them. */
    qtyMilli: z.number().int().min(1).max(1_000_000_000_000),
    unitPriceHtCentimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((l) => Boolean(l.componentId) || Boolean(l.description), 'a component or a description');

const schema = z.object({
  /** The order the invoice is for, by its printed code: office cannot read purchases. */
  purchaseCode: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.string().regex(PURCHASE_CODE)),
  supplierInvoiceNo: text(60),
  invoiceDate: date,
  /** Defaults to the invoice date + 60 days; never more than 120 (law 69-21). */
  dueDate: date.nullish(),
  lines: z.array(lineSchema).min(1).max(50),
  /** The receipts it covers; every receipt of the order no live invoice covers yet when absent. */
  receiptIds: z.array(z.uuid()).max(100).nullish(),
});

export type SupplierInvoiceInput = z.infer<typeof schema>;

export function parseSupplierInvoiceInput(input: unknown): Result<SupplierInvoiceInput, 'INVALID'> {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

export const SUPPLIER_INVOICE_STATES = ['entered', 'gaps_accepted', 'approved', 'rejected'] as const;
export type SupplierInvoiceState = (typeof SUPPLIER_INVOICE_STATES)[number];
