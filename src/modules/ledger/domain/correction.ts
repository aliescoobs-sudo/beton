import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';

/** CMD-2026-00012, ACH-2026-00003, FA-2026-00001: the only things a correction request can point at. */
export const DOCUMENT_CODE = /^(CMD|ACH|FA)-[0-9]{4}-[0-9]{5,}$/;

const schema = z.object({
  documentCode: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.string().regex(DOCUMENT_CODE)),
  reason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

export type CorrectionInput = z.infer<typeof schema>;

export function parseCorrectionInput(input: unknown): Result<CorrectionInput, 'INVALID'> {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
