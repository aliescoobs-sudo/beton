import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';

export const BASE_UNITS = ['g', 'mL', 'L'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

export interface Component {
  id: string;
  /** CMP-nn, generated, never changes. */
  code: string;
  nameFr: string;
  nameAr: string;
  /** The unit every quantity of this component is stored in; never changes. */
  baseUnit: BaseUnit;
  /** Low-stock alert level, in base units. */
  lowStockThreshold: number;
  status: 'active' | 'archived';
}

export interface PurchaseUnit {
  id: string;
  componentId: string;
  label: string;
  /** How many base units one purchase unit holds: a positive integer, fixed once created. */
  factorToBase: number;
  status: 'active' | 'archived';
}

// Spaces collapsed so "Gravette  8/15" and "Gravette 8/15" are one name.
const nameField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(80));

const emptyAsUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const componentInputSchema = z.object({
  nameFr: nameField,
  nameAr: nameField,
  baseUnit: z.enum(BASE_UNITS),
  lowStockThreshold: z.preprocess(emptyAsUndefined, z.number().int().min(0).default(0)),
});
export type ComponentInput = z.infer<typeof componentInputSchema>;

export function parseComponentInput(input: unknown): Result<ComponentInput, 'INVALID'> {
  const parsed = componentInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

const purchaseUnitInputSchema = z.object({
  label: nameField,
  // Integers only: a fractional factor would put a rounding in every conversion.
  factorToBase: z.number().int().min(1).max(2_000_000_000),
});
export type PurchaseUnitInput = z.infer<typeof purchaseUnitInputSchema>;

export function parsePurchaseUnitInput(input: unknown): Result<PurchaseUnitInput, 'INVALID'> {
  const parsed = purchaseUnitInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
