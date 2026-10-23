import { describe, expect, it } from 'vitest';
import {
  checkPaymentDays,
  DEFAULT_PAYMENT_DAYS,
  MAX_PAYMENT_DAYS,
  REGULARIZATION_WINDOW_DAYS,
} from './legal';

describe('legal constants', () => {
  it('law 71.24 (30 days) and law 69-21 (60 default, 120 maximum)', () => {
    expect(REGULARIZATION_WINDOW_DAYS).toBe(30);
    expect(DEFAULT_PAYMENT_DAYS).toBe(60);
    expect(MAX_PAYMENT_DAYS).toBe(120);
  });

  it('a payment term over 120 days is refused (AC-LED-09, domain part)', () => {
    expect(checkPaymentDays(60)).toEqual({ ok: true, value: 60 });
    expect(checkPaymentDays(120)).toEqual({ ok: true, value: 120 });
    expect(checkPaymentDays(121)).toEqual({ ok: false, error: 'PAYMENT_TERM_TOO_LONG' });
    expect(checkPaymentDays(-1)).toEqual({ ok: false, error: 'INVALID_PAYMENT_TERM' });
    expect(checkPaymentDays(30.5)).toEqual({ ok: false, error: 'INVALID_PAYMENT_TERM' });
  });
});
