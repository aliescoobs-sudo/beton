import { describe, expect, it } from 'vitest';
import {
  costBlocks,
  marginBp,
  marginsOf,
  materialsLineCentimes,
  mulDivRound,
  perM3Centimes,
  ratePerM3Centimes,
  salePriceCentimes,
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

describe('T17 G9: the sale price and the three margins', () => {
  const blocks = costBlocks({
    volumeL: 8_000n,
    method: 'POMPE',
    materialsLines: [599_008n],
    perTripMl: 22_000n,
    dieselCentimesPerL: 1_700n,
    deliveryOtherPerM3: 6_800n,
    pumpPerM3: 4_000n,
    plantPerM3: 4_000n,
    overheadPerM3: 3_000n,
  });
  it('the price of a BL is one rounding of unit price x litres / 1000, signed with the litres', () => {
    expect(salePriceCentimes(88_000n, 8_000n)).toBe(704_000n);
    expect(salePriceCentimes(88_001n, 3_333n)).toBe(293_307n);
    expect(salePriceCentimes(88_000n, -8_000n)).toBe(-704_000n);
    expect(salePriceCentimes(1n, 500n)).toBe(1n); // 0,5 centime: a tie goes away from zero
    expect(salePriceCentimes(1n, -500n)).toBe(-1n);
  });
  it('M1, M2 and M3 are plain subtractions; the pump counts from M2 on, the plant and overheads only in M3', () => {
    const price = salePriceCentimes(88_000n, 8_000n);
    const m = marginsOf(price, blocks);
    expect(m.m1).toBe(price - 599_008n);
    expect(m.m2).toBe(price - 599_008n - blocks.delivery - blocks.pump);
    expect(m.m3).toBe(price - blocks.total);
    expect(m.m1 > m.m2 && m.m2 > m.m3).toBe(true);
  });
  it('basis points of the price round half away from zero and are null without a positive price; a negative margin stays negative', () => {
    expect(marginBp(1n, 8n)).toBe(1_250n);
    expect(marginBp(1n, 3n)).toBe(3_333n);
    expect(marginBp(-1n, 3n)).toBe(-3_333n);
    expect(marginBp(5n, 0n)).toBeNull();
    expect(perM3Centimes(704_000n, 8_000n)).toBe(88_000n);
    expect(perM3Centimes(1n, 0n)).toBeNull();
  });
});
