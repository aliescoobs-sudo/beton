import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { defineVisibility } from '@/modules/platform-security';
import { dateField } from './date-field';

export interface RecetteLine {
  componentId: string;
  /** Base units of the component per m³ of concrete (integer). */
  qtyPerM3: number;
}

export interface Recette {
  id: string;
  concreteTypeId: string;
  version: number;
  /** Business date (YYYY-MM-DD) from which this version applies. */
  effectiveFrom: string;
  lines: RecetteLine[];
}

const recetteInputSchema = z.object({
  effectiveFrom: dateField,
  lines: z
    .array(
      z.object({
        componentId: z.uuid(),
        // Integers in base units: a decimal quantity would be a rounding hidden in the recette.
        qtyPerM3: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .refine((lines) => new Set(lines.map((l) => l.componentId)).size === lines.length),
});

export type RecetteInput = z.infer<typeof recetteInputSchema>;

export function parseRecetteInput(input: unknown): Result<RecetteInput, 'INVALID'> {
  const parsed = recetteInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

/**
 * The version in force on `date`: the one with the latest effective_from not after it (SPEC-master-data §3).
 * A date before the first version, or a type with no recette, is an error, never a guess.
 */
export function resolveRecette<T extends { effectiveFrom: string }>(
  versions: readonly T[],
  date: string,
): Result<T, 'NO_RECETTE'> {
  let best: T | undefined;
  for (const version of versions) {
    if (version.effectiveFrom <= date && (!best || version.effectiveFrom > best.effectiveFrom))
      best = version;
  }
  return best ? ok(best) : err('NO_RECETTE');
}

/**
 * What leaves the service for a recette (SPEC-platform-security §4 layer 4, AC-MD-07/AC-SEC-05). Quantities per m³
 * are all the plant and the office ever get; the computed cost (filled in by purchase prices, T10) is money: owner and
 * support only (DECISIONS 81). The allowlist means a field added later stays hidden until someone lists it.
 */
export interface RecetteView extends Recette {
  componentCostPerM3Centimes?: number;
}

export const recetteVisibility = defineVisibility<RecetteView>({
  owner: 'all',
  support: 'all',
  partner: ['id', 'concreteTypeId', 'version', 'effectiveFrom', 'lines'],
  office: ['id', 'concreteTypeId', 'version', 'effectiveFrom', 'lines'],
  plant: ['id', 'concreteTypeId', 'version', 'effectiveFrom', 'lines'],
});
