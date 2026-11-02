import { err, ok, type Result } from '@/lib/result';

/** A driver PIN: 4 to 6 digits, not a run, not a repeat, not a date-like pattern of one digit. */
export function parsePin(input: unknown): Result<string, 'INVALID' | 'TOO_EASY'> {
  if (typeof input !== 'string' || !/^\d{4,6}$/.test(input)) return err('INVALID');
  if (/^(\d)\1+$/.test(input)) return err('TOO_EASY');
  const digits = [...input].map(Number);
  const step = (digits[1] ?? 0) - (digits[0] ?? 0);
  if (Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - (digits[i - 1] ?? 0) === step))
    return err('TOO_EASY');
  return ok(input);
}

/** Five wrong PINs lock the account for fifteen minutes (a short PIN is only as safe as its attempt limit). */
export const PIN_MAX_FAILED = 5;
export const PIN_LOCK_MINUTES = 15;
