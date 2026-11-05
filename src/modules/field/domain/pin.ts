import { err, ok, type Result } from '@/lib/result';

/** The shortest PIN that can be SET (F11). A PIN set before this rule is 4 to 6 digits and still signs in until it is reset. */
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 8;

/** The shape a phone may send at sign-in: a PIN set under the old rule (4 digits) must still be recognised, never created. */
export function parseLoginPin(input: unknown): Result<string, 'INVALID'> {
  return typeof input === 'string' && /^\d{4,8}$/.test(input) ? ok(input) : err('INVALID');
}

/** A new driver PIN: 6 to 8 digits, not a run, not a repeat. */
export function parsePin(input: unknown): Result<string, 'INVALID' | 'TOO_EASY'> {
  if (typeof input !== 'string' || !new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(input))
    return err('INVALID');
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
