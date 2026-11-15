import { describe, expect, it } from 'vitest';
import {
  costBlocks,
  materialsLineCentimes,
  mulDivRound,
  ratePerM3Centimes,
  tripFuelCentimes,
} from './cost-arithmetic';

describe('mulDivRound: half away from zero, exact on integers', () => {
  it('rounds ties away from zero, both signs', () => {
    expect(mulDivRound(5n, 2n)).toBe(3n);
    expect(mulDivRound(-5n, 2n)).toBe(-3n);
    expect(mulDivRound(1n, 2n)).toBe(1n);
    expect(mulDivRound(-1n, 2n)).toBe(-1n);
    expect(mulDivRound(7n, 3n)).toBe(2n);
    expect(mulDivRound(-7n, 3n)).toBe(-2n);
    expect(mulDivRound(0n, 7n)).toBe(0n);
    expect(mulDivRound(10n, 5n)).toBe(2n);
  });
  it('is exact on products far beyond a double', () => {
    expect(mulDivRound(10n ** 30n + 5n * 10n ** 29n, 10n ** 30n)).toBe(2n);
  });
  it('refuses a non-positive denominator', () => {
    expect(() => mulDivRound(1n, 0n)).toThrow();
    expect(() => mulDivRound(1n, -2n)).toThrow();
  });
});

describe('the elements of a load (a hand-checked load of the fictitious FX-B25-P recette)', () => {
  it('a materials line is one rounding of dose x litres x delivered price', () => {
    // 380 kg of FX GI per m3 (380 000 g), 8 m3, 130 DH/t + 40 DH/t transport, one tonne = 1 000 000 g: 516,80 DH
    expect(
      materialsLineCentimes({
        qtyPerM3: 380_000n,
        volumeL: 8_000n,
        priceCentimes: 13_000n,
        transportCentimes: 4_000n,
        factorToBase: 1_000_000n,
      }),
    ).toBe(51_680n);
    // 3 333 litres: 21 531,09 centimes round to 21 531
    expect(
      materialsLineCentimes({
        qtyPerM3: 380_000n,
        volumeL: 3_333n,
        priceCentimes: 13_000n,
        transportCentimes: 4_000n,
        factorToBase: 1_000_000n,
      }),
    ).toBe(21_531n);
  });
  it('the trip fuel and the per-m3 rates', () => {
    expect(tripFuelCentimes(22_000n, 1_700n)).toBe(37_400n);
    expect(ratePerM3Centimes(2_125n, 3_333n)).toBe(7_083n);
    expect(ratePerM3Centimes(2_125n, 8_000n)).toBe(17_000n);
  });
  it('the five blocks; a missing input costs 0 and the pump exists for POMPE only', () => {
    const base = {
      volumeL: 8_000n,
      materialsLines: [51_680n, 43_200n],
      perTripMl: 22_000n,
      dieselCentimesPerL: 1_700n,
      deliveryOtherPerM3: 2_125n,
      pumpPerM3: 4_000n,
      plantPerM3: 4_000n,
      overheadPerM3: 3_000n,
    };
    expect(costBlocks({ ...base, method: 'POMPE' })).toEqual({
      materials: 94_880n,
      delivery: 54_400n,
      pump: 32_000n,
      plant: 32_000n,
      overheads: 24_000n,
      total: 237_280n,
    });
    expect(costBlocks({ ...base, method: 'GOULOTTE' }).pump).toBe(0n);
    expect(costBlocks({ ...base, method: null }).pump).toBe(0n);
    const none = costBlocks({
      ...base,
      method: 'POMPE',
      perTripMl: null,
      deliveryOtherPerM3: null,
      plantPerM3: null,
    });
    expect(none.delivery).toBe(0n);
    expect(none.plant).toBe(0n);
    expect(none.total).toBe(none.materials + none.pump + none.overheads);
  });
});
