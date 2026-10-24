import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeInvoiceTotals, invoiceDueDate, invoiceIssueDeadline, parseInvoiceInput } from './invoice';

describe('invoiceIssueDeadline (law 69-21, AC-LED-15)', () => {
  it.each([
    ['2026-03-05', '2026-03-31'],
    ['2026-04-30', '2026-04-30'],
    ['2026-02-10', '2026-02-28'],
    ['2028-02-10', '2028-02-29'],
    ['2026-12-01', '2026-12-31'],
  ])('delivery %s -> %s', (delivery, deadline) => {
    expect(invoiceIssueDeadline(delivery)).toBe(deadline);
  });
  it('refuses a non-date', () => {
    expect(() => invoiceIssueDeadline('2026-02-30')).toThrow();
  });
});

describe('invoiceDueDate (AC-LED-09)', () => {
  it('defaults to the invoice date + 60 days', () => {
    expect(invoiceDueDate('2026-03-01', null)).toEqual({ ok: true, value: '2026-04-30' });
  });
  it('accepts 120 days, refuses 121 and a date before the invoice', () => {
    expect(invoiceDueDate('2026-01-01', '2026-05-01')).toEqual({ ok: true, value: '2026-05-01' });
    expect(invoiceDueDate('2026-01-01', '2026-05-02')).toEqual({ ok: false, error: 'PAYMENT_TERM_TOO_LONG' });
    expect(invoiceDueDate('2026-03-10', '2026-03-09')).toEqual({ ok: false, error: 'DUE_BEFORE_INVOICE' });
  });
});

describe('computeInvoiceTotals', () => {
  it('two loads of 8 m³ and 4 m³ at 780,00: HT 9 360,00, VAT 20 % 1 872,00, TTC 11 232,00', () => {
    const r = computeInvoiceTotals(
      [
        { volumeL: 8000, unitPriceHtCentimes: 78_000 },
        { volumeL: 4000, unitPriceHtCentimes: 78_000 },
      ],
      2000,
    );
    expect(r.ok && r.value.lineHt).toEqual([624_000, 312_000]);
    expect(r.ok && [r.value.totalHt, r.value.totalVat, r.value.totalTtc]).toEqual([
      936_000, 187_200, 1_123_200,
    ]);
  });
  it('rounds each line once, half away from zero (7,5 m³ at 855,55)', () => {
    const r = computeInvoiceTotals([{ volumeL: 7500, unitPriceHtCentimes: 85_555 }], 0);
    expect(r.ok && r.value.lineHt).toEqual([641_663]); // 641 662,5 -> away from zero
  });
  it('refuses no lines, a zero volume or price, a silly rate', () => {
    expect(computeInvoiceTotals([], 2000).ok).toBe(false);
    expect(computeInvoiceTotals([{ volumeL: 0, unitPriceHtCentimes: 5 }], 2000).ok).toBe(false);
    expect(computeInvoiceTotals([{ volumeL: 5, unitPriceHtCentimes: 0 }], 2000).ok).toBe(false);
    expect(computeInvoiceTotals([{ volumeL: 5, unitPriceHtCentimes: 5 }], 10_001).ok).toBe(false);
  });
  it('property: TTC = Σ lines + VAT exactly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            volumeL: fc.integer({ min: 1, max: 30_000 }),
            unitPriceHtCentimes: fc.integer({ min: 1, max: 500_000 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 2500 }),
        (lines, bp) => {
          const r = computeInvoiceTotals(lines, bp);
          if (!r.ok) return false;
          return (
            r.value.lineHt.reduce((a, b) => a + b, 0) === r.value.totalHt &&
            r.value.totalTtc === r.value.totalHt + r.value.totalVat
          );
        },
      ),
    );
  });
});

describe('parseInvoiceInput', () => {
  const id = '0192f3a0-0000-7000-8000-000000000001';
  it('accepts an order alone, or with loads and a due date; refuses an empty list of loads', () => {
    expect(parseInvoiceInput({ orderId: id }).ok).toBe(true);
    expect(parseInvoiceInput({ orderId: id, deliveryIds: [id], dueDate: '2026-05-01' }).ok).toBe(true);
    expect(parseInvoiceInput({ orderId: id, deliveryIds: [] }).ok).toBe(false);
    expect(parseInvoiceInput({ orderId: 'x' }).ok).toBe(false);
  });
});
