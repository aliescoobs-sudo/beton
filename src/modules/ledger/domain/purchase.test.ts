import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computePurchaseTotals, parsePurchaseInput, purchaseDueDate } from './purchase';

describe('computePurchaseTotals', () => {
  it('30 t of cement at 1 450,00 per t plus 2 500,00 of transport, VAT 20 %', () => {
    const r = computePurchaseTotals(
      [
        { qtyMilli: 30_000, unitPriceHtCentimes: 145_000 },
        { qtyMilli: 1000, unitPriceHtCentimes: 250_000 },
      ],
      2000,
    );
    expect(r.ok && r.value.lineHt).toEqual([4_350_000, 250_000]);
    expect(r.ok && [r.value.totalHt, r.value.totalVat, r.value.totalTtc]).toEqual([
      4_600_000, 920_000, 5_520_000,
    ]);
  });

  it('rounds each line once, half away from zero (0,333 t at 1 450,00 = 482,85)', () => {
    const r = computePurchaseTotals([{ qtyMilli: 333, unitPriceHtCentimes: 145_000 }], 0);
    expect(r.ok && r.value.lineHt).toEqual([48_285]);
  });

  it('refuses an empty purchase, a zero quantity or price and a silly VAT rate', () => {
    expect(computePurchaseTotals([], 2000)).toEqual({ ok: false, error: 'INVALID_LINE' });
    expect(computePurchaseTotals([{ qtyMilli: 0, unitPriceHtCentimes: 5 }], 2000).ok).toBe(false);
    expect(computePurchaseTotals([{ qtyMilli: 5, unitPriceHtCentimes: 0 }], 2000).ok).toBe(false);
    expect(computePurchaseTotals([{ qtyMilli: 5, unitPriceHtCentimes: 5 }], 10_001)).toEqual({
      ok: false,
      error: 'INVALID_VAT_RATE',
    });
  });

  it('property: TTC = Σ line HT + VAT, exactly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qtyMilli: fc.integer({ min: 1, max: 5_000_000 }),
            unitPriceHtCentimes: fc.integer({ min: 1, max: 5_000_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 2500 }),
        (lines, bp) => {
          const r = computePurchaseTotals(lines, bp);
          if (!r.ok) return true; // a line that rounds to nothing is refused, never stored
          return (
            r.value.lineHt.reduce((a, b) => a + b, 0) === r.value.totalHt &&
            r.value.totalTtc === r.value.totalHt + r.value.totalVat
          );
        },
      ),
    );
  });
});

describe('purchaseDueDate (law 69-21, AC-LED-16)', () => {
  it('defaults to the supplier invoice date + 60 days, else the order date + 60', () => {
    expect(purchaseDueDate('2026-03-01', '2026-03-10', null)).toEqual({ ok: true, value: '2026-05-09' });
    expect(purchaseDueDate('2026-03-01', null, undefined)).toEqual({ ok: true, value: '2026-04-30' });
  });
  it('accepts exactly 120 days and refuses 121', () => {
    expect(purchaseDueDate('2026-01-01', '2026-01-01', '2026-05-01')).toEqual({
      ok: true,
      value: '2026-05-01',
    });
    expect(purchaseDueDate('2026-01-01', '2026-01-01', '2026-05-02')).toEqual({
      ok: false,
      error: 'PAYMENT_TERM_TOO_LONG',
    });
  });
  it('refuses a due date before the order', () => {
    expect(purchaseDueDate('2026-03-10', null, '2026-03-09')).toEqual({
      ok: false,
      error: 'DUE_BEFORE_ORDER',
    });
  });
});

describe('parsePurchaseInput', () => {
  const id = '0192f3a0-0000-7000-8000-000000000001';
  it('accepts a stocked line and a service line', () => {
    const r = parsePurchaseInput({
      supplierId: id,
      lines: [
        { componentId: id, purchaseUnitId: id, qtyMilli: 30_000, unitPriceHtCentimes: 145_000 },
        { description: ' Transport ', unitPriceHtCentimes: 250_000 },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it('refuses no lines and a plan item with two kinds of share', () => {
    expect(parsePurchaseInput({ supplierId: id, lines: [] }).ok).toBe(false);
    expect(
      parsePurchaseInput({
        supplierId: id,
        lines: [{ description: 'x', unitPriceHtCentimes: 5 }],
        plan: [{ method: 'cheque', dueDate: '2026-05-01', percentBp: 100, amountCentimes: 5 }],
      }).ok,
    ).toBe(false);
  });
});
