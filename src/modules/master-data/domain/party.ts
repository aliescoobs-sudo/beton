import { z } from 'zod';

/** Moroccan ICE: 15 digits. Spaces and dashes typed by the user are dropped; anything else is rejected. */
export function normalizeIce(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, '');
  return /^[0-9]{15}$/.test(digits) ? digits : null;
}

/**
 * Key for the "similar name" warning: case, accents, punctuation and spacing are ignored, so "Société  Atlas S.A."
 * and "societe atlas s a" collide. Arabic letters are kept (they are letters), their diacritics are dropped.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const NAME_MAX = 120;
export const NOTES_MAX = 2000;
export const PAYMENT_TERMS_MAX_DAYS = 120;
export const PAYMENT_TERMS_DEFAULT_DAYS = 60;

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

export const nameField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(NAME_MAX));

/** Optional ICE, stored normalized. A malformed ICE is an error, never silently dropped. */
export const iceField = optional(
  z.string().transform((value, ctx) => {
    const ice = normalizeIce(value);
    if (ice === null) ctx.addIssue({ code: 'custom', message: 'ICE must be 15 digits' });
    return ice ?? '';
  }),
);

export const phoneField = optional(
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().regex(/^[+0-9 ()./-]{6,20}$/)),
);

export const textField = (max: number) =>
  optional(
    z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(max)),
  );

export const paymentTermsField = z.preprocess(
  blankToUndefined,
  z.number().int().min(0).max(PAYMENT_TERMS_MAX_DAYS).default(PAYMENT_TERMS_DEFAULT_DAYS),
);

export const reasonField = optional(
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(3).max(500)),
);
