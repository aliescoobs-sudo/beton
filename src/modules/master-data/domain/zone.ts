import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';

export interface Zone {
  id: string;
  name: string;
  /** One-way trip time from the plant, minutes (SPEC-master-data §2). */
  oneWayMin: number;
}

export const ZONE_NAME_MAX = 80;
export const ZONE_ONE_WAY_MIN = { min: 1, max: 480 } as const;

const zoneInputSchema = z.object({
  // Spaces collapsed so "Oued  Laou" and "Oued Laou" are the same name for the uniqueness check.
  name: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(ZONE_NAME_MAX)),
  oneWayMin: z.number().int().min(ZONE_ONE_WAY_MIN.min).max(ZONE_ONE_WAY_MIN.max),
});

export type ZoneInput = z.infer<typeof zoneInputSchema>;

export function parseZoneInput(input: unknown): Result<ZoneInput, 'INVALID'> {
  const parsed = zoneInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
