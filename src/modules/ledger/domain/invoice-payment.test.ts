import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { invoicePayment } from './invoice-payment';

describe('invoicePayment', () => {
  it('unpaid, partial and paid by what was covered', () => {
    expect(invoicePayment(1_000, 0)).toEqual({ state: 'unpaid', paidCentimes: 0 });
    expect(invoicePayment(1_000, 300)).toEqual({ state: 'partial', paidCentimes: 300 });
    expect(invoicePayment(1_000, 1_000)).toEqual({ state: 'paid', paidCentimes: 1_000 });
  });

  it('never more than the total, never less than nothing', () => {
    expect(invoicePayment(1_000, 99_999)).toEqual({ state: 'paid', paidCentimes: 1_000 });
    expect(invoicePayment(1_000, -5)).toEqual({ state: 'unpaid', paidCentimes: 0 });
  });

  it('paid is between 0 and the total, and the state agrees (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: -100, max: 200_000 }),
        (total, covered) => {
          const p = invoicePayment(total, covered);
          expect(p.paidCentimes).toBeGreaterThanOrEqual(0);
          expect(p.paidCentimes).toBeLessThanOrEqual(total);
          expect(p.state === 'paid').toBe(p.paidCentimes === total);
          expect(p.state === 'unpaid').toBe(p.paidCentimes === 0);
        },
      ),
    );
  });
});
