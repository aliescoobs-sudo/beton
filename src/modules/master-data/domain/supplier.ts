import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { iceField, nameField, phoneField } from './party';

export const SUPPLIER_CATEGORIES = [
  'cement',
  'aggregates',
  'admixture',
  'transport',
  'fuel',
  'other',
] as const;
export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];

export interface Supplier {
  id: string;
  /** FRN-nn, generated, never changes. */
  code: string;
  name: string;
  category: SupplierCategory;
  ice: string | null;
  phone: string | null;
  paymentTermsDays: number;
  status: 'active' | 'archived';
}

const supplierInputSchema = z.object({
  name: nameField,
  category: z.enum(SUPPLIER_CATEGORIES),
  ice: iceField,
  phone: phoneField,
  paymentTermsDays: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.number().int().min(0).max(365).default(30),
  ),
});

export type SupplierInput = z.infer<typeof supplierInputSchema>;

export function parseSupplierInput(input: unknown): Result<SupplierInput, 'INVALID'> {
  const parsed = supplierInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
