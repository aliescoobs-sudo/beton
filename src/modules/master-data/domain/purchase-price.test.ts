import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  componentCostPerM3,
  parsePurchasePriceInput,
  resolvePurchasePrice,
  type PricePoint,
} from './purchase-price';

const point = (
  componentId: string,
  effectiveFrom: string,
  priceHtCentimes: number,
  factorToBase: number,
) => ({
  componentId,
  effectiveFrom,
  priceHtCentimes,
  factorToBase,
});

describe('componentCostPerM3 (AC-MD-04)', () => {
  it('2.5 t of cement at 1 450,00 MAD/t HT costs 3 625,00 MAD', () => {
    // 2 500 000 g of cement per m³ (an absurd recette, but the example of the spec), 145 000 centimes per tonne.
    const cost = componentCostPerM3(
      [{ componentId: 'cement', qtyPerM3: 2_500_000 }],
      [point('cement', '2026-01-01', 145_000, 1_000_000)],
      '2026-06-01',
    );
    expect(cost).toEqual({ ok: true, value: 362_500 });
  });

  it('adds the lines, each rounded once', () => {
    const cost = componentCostPerM3(
      [
        { componentId: 'a', qtyPerM3: 1 },
        { componentId: 'b', qtyPerM3: 1 },
      ],
      [point('a', '2026-01-01', 1, 2), point('b', '2026-01-01', 1, 2)], // 0.5 → 1 centime each
      '2026-06-01',
    );
    expect(cost).toEqual({ ok: true, value: 2 });
  });

  it('errors (never 0) when a component has no price on that date', () => {
    const lines = [{ componentId: 'a', qtyPerM3: 10 }];
    expect(componentCostPerM3(lines, [], '2026-06-01')).toEqual({ ok: false, error: 'NO_PRICE' });
    expect(componentCostPerM3(lines, [point('a', '2026-07-01', 100, 1)], '2026-06-01')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
  });

  it('uses the version in force on the date', () => {
    const prices = [point('a', '2026-01-01', 100, 1), point('a', '2026-06-01', 300, 1)];
    const lines = [{ componentId: 'a', qtyPerM3: 10 }];
    expect(componentCostPerM3(lines, prices, '2026-05-31')).toEqual({ ok: true, value: 1000 });
    expect(componentCostPerM3(lines, prices, '2026-06-01')).toEqual({ ok: true, value: 3000 });
  });

  it('is an integer number of centimes, and the same price expressed per kg or per tonne agrees (±1 centime)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (qty, perKg) => {
          const lines = [{ componentId: 'a', qtyPerM3: qty }];
          const kg = componentCostPerM3(lines, [point('a', '2026-01-01', perKg, 1000)], '2026-02-01');
          const tonne = componentCostPerM3(
            lines,
            [point('a', '2026-01-01', perKg * 1000, 1_000_000)],
            '2026-02-01',
          );
          if (!kg.ok || !tonne.ok) throw new Error('unexpected NO_PRICE');
          expect(Number.isSafeInteger(kg.value)).toBe(true);
          expect(Math.abs(kg.value - tonne.value)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('resolvePurchasePrice', () => {
  const prices: PricePoint[] = [point('a', '2026-03-01', 1, 1), point('b', '2026-01-01', 2, 1)];
  it('picks the component and the latest version not after the date', () => {
    expect(resolvePurchasePrice(prices, 'a', '2026-03-01')).toMatchObject({
      ok: true,
      value: { priceHtCentimes: 1 },
    });
    expect(resolvePurchasePrice(prices, 'a', '2026-02-28')).toEqual({ ok: false, error: 'NO_PRICE' });
  });
});

describe('parsePurchasePriceInput', () => {
  const id = '019c0000-0000-7000-8000-000000000001';
  const valid = {
    componentId: id,
    supplierId: id,
    purchaseUnitId: id,
    priceHtCentimes: 145_000,
    effectiveFrom: '2026-01-01',
  };
  it('accepts integer centimes and a real date', () => {
    expect(parsePurchasePriceInput(valid).ok).toBe(true);
  });
  it.each([
    ['a fractional price', { ...valid, priceHtCentimes: 1.5 }],
    ['a zero price', { ...valid, priceHtCentimes: 0 }],
    ['a negative price', { ...valid, priceHtCentimes: -5 }],
    ['an impossible date', { ...valid, effectiveFrom: '2026-02-30' }],
    ['a missing supplier', { ...valid, supplierId: undefined }],
  ])('refuses %s', (_name, input) => {
    expect(parsePurchasePriceInput(input)).toEqual({ ok: false, error: 'INVALID' });
  });
});
