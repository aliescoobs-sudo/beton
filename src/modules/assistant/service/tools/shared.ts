import { z } from 'zod';
import { isIsoDate } from '../../domain/units';

export const CLIENT_CODE = z.string().regex(/^CLT-\d{1,6}$/, 'a client code like CLT-017');
export const DOC_CODE = z.string().regex(/^[A-Za-z0-9/-]{4,40}$/);

/** An ISO date within 400 days of today: the dates the model can name are bounded (SPEC-assistant §8). */
export const boundedDate = (today: string) =>
  z
    .string()
    .refine(
      (d) =>
        isIsoDate(d) &&
        Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) <= 400 * 86_400_000,
      {
        error: 'a date within 400 days of today',
      },
    );

export const ISO_DATE_OUT = z.string();
