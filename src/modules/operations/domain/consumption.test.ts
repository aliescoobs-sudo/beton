import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { consumptionForLoad } from './consumption';
import { remainingVolume, stockLevel, stockStatus } from './stock';

const B25 = [
  { componentId: 'cement', qtyPerM3: 350_000 },
  { componentId: 'sand', qtyPerM3: 800_000 },
  { componentId: 'water', qtyPerM3: 180 },
  { componentId: 'admixture', qtyPerM3: 3_500 },
];

describe('consumptionForLoad (AC-OPS-02)', () => {
  it('8 m³ of B25 takes 2 800 000 g of cement and the matching quantity of every other component', () => {
    expect(consumptionForLoad(B25, 8000)).toEqual([
      { componentId: 'cement', qtyBase: 2_800_000 },
      { componentId: 'sand', qtyBase: 6_400_000 },
      { componentId: 'water', qtyBase: 1_440 },
      { componentId: 'admixture', qtyBase: 28_000 },
    ]);
  });

  it('rounds once per line, half away from zero (7,5 m³ of water: 180 × 7 500 / 1 000 = 1 350; 3 500 × 7 / 1 000 = 24,5 → 25)', () => {
    expect(consumptionForLoad(B25, 7500)[2]?.qtyBase).toBe(1350);
    expect(consumptionForLoad([{ componentId: 'a', qtyPerM3: 3500 }], 7)[0]?.qtyBase).toBe(25);
    expect(consumptionForLoad([{ componentId: 'a', qtyPerM3: 3500 }], 3)[0]?.qtyBase).toBe(11); // 10,5 → 11
  });

  it('refuses a load without a usable volume', () => {
    expect(() => consumptionForLoad(B25, 0)).toThrow(RangeError);
    expect(() => consumptionForLoad(B25, 1.5)).toThrow(RangeError);
  });

  it('property: over any loads, the total taken is the recette times the total m³, within one base unit per load', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 30_000 }), { minLength: 1, maxLength: 20 }),
        (qtyPerM3, loads) => {
          const taken = loads.reduce(
            (n, v) => n + (consumptionForLoad([{ componentId: 'c', qtyPerM3 }], v)[0]?.qtyBase ?? 0),
            0,
          );
          const exact = (qtyPerM3 * loads.reduce((n, v) => n + v, 0)) / 1000;
          return Math.abs(taken - exact) <= loads.length / 2;
        },
      ),
    );
  });
});

describe('stock', () => {
  it('is the sum of the movements', () => {
    expect(stockLevel([30_000_000, -2_800_000, -2_800_000])).toBe(24_400_000);
    expect(stockLevel([])).toBe(0);
  });

  it('is short below zero, low below the threshold, ok otherwise', () => {
    expect(stockStatus(-1, 100)).toBe('short');
    expect(stockStatus(99, 100)).toBe('low');
    expect(stockStatus(100, 100)).toBe('ok');
    expect(stockStatus(5, null)).toBe('ok');
    expect(stockStatus(0, 100)).toBe('low');
  });

  it('remaining volume never goes negative', () => {
    expect(remainingVolume(120_000, [8000, 8000])).toBe(104_000);
    expect(remainingVolume(8000, [8000, 8000])).toBe(0);
  });
});
