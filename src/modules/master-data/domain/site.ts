import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { textField } from './party';

export interface ClientSite {
  id: string;
  clientId: string;
  label: string;
  address: string | null;
  zoneId: string | null;
}

const siteInputSchema = z.object({
  label: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(120)),
  address: textField(500),
  zoneId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()),
});

export type SiteInput = z.infer<typeof siteInputSchema>;

export function parseSiteInput(input: unknown): Result<SiteInput, 'INVALID'> {
  const parsed = siteInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
