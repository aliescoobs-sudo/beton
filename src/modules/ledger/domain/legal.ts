import { err, ok, type Result } from '@/lib/result';

/** Law 71.24: a bounced cheque or LCN can be regularized within 30 days of the bounce. A legal constant, not a parameter. */
export const REGULARIZATION_WINDOW_DAYS = 30;

/** Law 69-21 (payment terms): the default term is 60 days, the legal maximum 120 days. */
export const DEFAULT_PAYMENT_DAYS = 60;
export const MAX_PAYMENT_DAYS = 120;

/** A payment term in days: a whole number from 0 to the legal maximum. */
export function checkPaymentDays(
  days: number,
): Result<number, 'PAYMENT_TERM_TOO_LONG' | 'INVALID_PAYMENT_TERM'> {
  if (!Number.isSafeInteger(days) || days < 0) return err('INVALID_PAYMENT_TERM');
  return days > MAX_PAYMENT_DAYS ? err('PAYMENT_TERM_TOO_LONG') : ok(days);
}
