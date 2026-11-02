import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';

/** A plant (centrale) of the company: Tétouan, Chefchaouen (REQUIREMENTS-V1 §1). */
export interface Plant {
  id: string;
  /** Short upper-case code, e.g. TETOUAN; typed once, never changes. */
  code: string;
  name: string;
  status: 'active' | 'archived';
}

const plantInputSchema = z.object({
  code: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2,8}$/)),
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(80)),
});
export type PlantInput = z.infer<typeof plantInputSchema>;

export function parsePlantInput(input: unknown): Result<PlantInput, 'INVALID'> {
  const parsed = plantInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
