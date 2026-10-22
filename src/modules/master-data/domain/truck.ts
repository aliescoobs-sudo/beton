import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { dateField } from './date-field';

export const TRUCK_STATUSES = ['available', 'breakdown', 'roadblock'] as const;
export type TruckLogStatus = (typeof TRUCK_STATUSES)[number];

export const DEFAULT_TRUCK_CAPACITY_L = 8000;
export const TRUCK_CAPACITY_L = { min: 1000, max: 30000 } as const;

export interface Truck {
  id: string;
  /** T1, T2...: typed once by a manager, never changes. */
  code: string;
  plate: string;
  capacityL: number;
  status: 'active' | 'archived';
}

/**
 * One entry of the append-only status log. The period is [fromDate, toDate): toDate is the first day the truck is
 * back, null means until further notice. A later entry overrides an earlier one on the days they share, so
 * `available` ends a breakdown early without editing anything.
 */
export interface TruckStatusEntry {
  id: string;
  truckId: string;
  status: TruckLogStatus;
  fromDate: string;
  toDate: string | null;
  reason: string;
  /** Order of logging; the latest entry covering a day decides that day. */
  createdAt: string;
}

const plateField = z
  .string()
  // "12345-A-1" and "12345 - A - 1" are the same plate for the uniqueness check.
  .transform((value) => value.trim().replace(/\s+/g, ' ').toUpperCase())
  .pipe(z.string().min(3).max(20));

const capacityField = z.number().int().min(TRUCK_CAPACITY_L.min).max(TRUCK_CAPACITY_L.max);

const truckInputSchema = z.object({
  code: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.string().regex(/^T[0-9]{1,3}$/)),
  plate: plateField,
  capacityL: capacityField.default(DEFAULT_TRUCK_CAPACITY_L),
});
export type TruckInput = z.infer<typeof truckInputSchema>;

const truckEditSchema = z.object({ plate: plateField, capacityL: capacityField });
export type TruckEdit = z.infer<typeof truckEditSchema>;

const reasonField = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(500));

const statusEntrySchema = z
  .object({
    truckId: z.string().min(1),
    status: z.enum(TRUCK_STATUSES),
    fromDate: dateField,
    toDate: dateField.nullable(),
    reason: reasonField,
  })
  // ISO dates compare as strings.
  .refine((entry) => entry.toDate === null || entry.toDate > entry.fromDate);
export type TruckStatusInput = z.infer<typeof statusEntrySchema>;

export function parseTruckInput(input: unknown): Result<TruckInput, 'INVALID'> {
  const parsed = truckInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

export function parseTruckEdit(input: unknown): Result<TruckEdit, 'INVALID'> {
  const parsed = truckEditSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

export function parseTruckStatusInput(input: unknown): Result<TruckStatusInput, 'INVALID'> {
  const parsed = statusEntrySchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
