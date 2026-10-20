import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';

export interface ConcreteType {
  id: string;
  /** B20, B25...: typed once by a manager, never changes. */
  code: string;
  label: string;
  status: 'active' | 'archived';
}

const labelField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(80));

const concreteTypeInputSchema = z.object({
  code: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/)),
  label: labelField,
});
export type ConcreteTypeInput = z.infer<typeof concreteTypeInputSchema>;

export function parseConcreteTypeInput(input: unknown): Result<ConcreteTypeInput, 'INVALID'> {
  const parsed = concreteTypeInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

export function parseConcreteTypeLabel(label: unknown): Result<string, 'INVALID'> {
  const parsed = labelField.safeParse(label);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
