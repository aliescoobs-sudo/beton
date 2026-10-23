import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { computeTotals } from './totals';

describe('computeTotals (AC-LED-01)', () => {
  it('120 m³ of B25 at 780,00 HT with 20 % VAT: 93 600,00 / 18 720,00 / 112 320,00', () => {
    expect(computeTotals(120_000, centimes(78_000), 2000)).toEqual({
      ok: true,
      value: { totalHt: 9_360_000, totalVat: 1_872_000, totalTtc: 11_232_000 },
    });
  });

  it('rounds each fraction once, half away from zero (7,5 m³ at 851,33 HT, 14 %)', () => {
    // HT = 85 133 × 7 500 / 1 000 = 638 497,5 → 638 498; VAT = 638 498 × 1 400 / 10 000 = 89 389,72 → 89 390.
    expect(computeTotals(7500, centimes(85_133), 1400)).toEqual({
      ok: true,
      value: { totalHt: 638_498, totalVat: 89_390, totalTtc: 727_888 },
    });
  });

  it('a VAT rate of 0 gives TTC = HT', () => {
    const r = computeTotals(1000, centimes(12_345), 0);
    expect(r).toMatchObject({ ok: true, value: { totalVat: 0, totalTtc: 12_345 } });
  });

  it.each([
    [0, 78_000, 2000, 'INVALID_VOLUME'],
    [1.5, 78_000, 2000, 'INVALID_VOLUME'],
    [-1000, 78_000, 2000, 'INVALID_VOLUME'],
    [1000, 0, 2000, 'INVALID_PRICE'],
    [1000, 78_000, -1, 'INVALID_VAT_RATE'],
    [1000, 78_000, 10_001, 'INVALID_VAT_RATE'],
    [1000, 78_000, 20.5, 'INVALID_VAT_RATE'],
  ])('refuses volume %s, price %s, rate %s (%s)', (volume, price, rate, error) => {
    expect(computeTotals(volume, price as never, rate)).toEqual({ ok: false, error });
  });

  it('property: TTC = HT + VAT exactly, and VAT is within half a centime of the exact figure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 2500 }),
        (litres, price, rate) => {
          const r = computeTotals(litres, centimes(price), rate);
          if (!r.ok) return false;
          const { totalHt, totalVat, totalTtc } = r.value;
          const exactVat = Number((BigInt(totalHt) * BigInt(rate)) / 10_000n);
          return (
            BigInt(totalTtc) === BigInt(totalHt) + BigInt(totalVat) && Math.abs(totalVat - exactVat) <= 1
          );
        },
      ),
    );
  });
});
