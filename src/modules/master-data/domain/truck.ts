import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { dateField } from './date-field';

export const TRUCK_STATUSES = ['available', 'breakdown', 'roadblock'] as const;
export type TruckLogStatus = (typeof TRUCK_STATUSES)[number];

export const DEFAULT_TRUCK_CAPACITY_L = 8000;
export const TRUCK_CAPACITY_L = { min: 1000, max: 30000 } as const;

/**
 * Capacity is typed and shown in m³ (a truck mixer is "8 m³"), stored in litres. Exact decimal handling on the text,
 * no float: "8", "8,5" and "8.25" are accepted, at most 3 decimals (1 m³ = 1000 L).
 */
export function parseCapacityM3(text: string): Result<number, 'INVALID'> {
  const match = /^(\d{1,3})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!match) return err('INVALID');
  const litres = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return litres >= TRUCK_CAPACITY_L.min && litres <= TRUCK_CAPACITY_L.max ? ok(litres) : err('INVALID');
}

/** 8000 -> "8", 8500 -> "8,5", 8250 -> "8,25". */
export function formatCapacityM3(litres: number): string {
  const whole = Math.floor(litres / 1000);
  const decimals = String(litres % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return decimals ? `${whole},${decimals}` : `${whole}`;
}

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
