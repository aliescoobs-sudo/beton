import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultEntryUnit, formatEntryQty, magnitudeWarnings, parseEntryQty } from './recette-units';

describe('parseEntryQty', () => {
  it.each([
    ['350', 'g', 'kg', 350_000],
    ['350,5', 'g', 'kg', 350_500],
    ['350.5', 'g', 'kg', 350_500],
    ['0,35', 'g', 't', 350_000],
    ['1', 'g', 't', 1_000_000],
    ['180', 'L', 'L', 180],
    ['900', 'mL', 'mL', 900],
    ['1,5', 'mL', 'L', 1_500],
  ] as const)('%s %s→%s = %i base units', (text, base, unit, expected) => {
    expect(parseEntryQty(text, base, unit)).toEqual({ ok: true, value: expected });
  });

  it('refuses what is not a whole number of base units, instead of rounding', () => {
    expect(parseEntryQty('0,0005', 'g', 'kg')).toEqual({ ok: false, error: 'INVALID_QUANTITY' }); // finer than 1 g
    expect(parseEntryQty('0,5', 'L', 'L')).toEqual({ ok: false, error: 'FRACTIONAL_BASE_UNIT' });
  });

  it.each(['', 'abc', '-5', '1e3', '1,2345', '1 000'])('refuses %j', (text) => {
    expect(parseEntryQty(text, 'g', 'kg')).toEqual({ ok: false, error: 'INVALID_QUANTITY' });
  });

  it('refuses a unit that does not fit the component', () => {
    expect(parseEntryQty('5', 'L', 'kg')).toEqual({ ok: false, error: 'UNKNOWN_UNIT' });
    expect(parseEntryQty('5', 'g', 'mL')).toEqual({ ok: false, error: 'UNKNOWN_UNIT' });
  });

  it('the default unit is kg for solids, mL for admixtures, L for water', () => {
    expect([defaultEntryUnit('g'), defaultEntryUnit('mL'), defaultEntryUnit('L')]).toEqual(['kg', 'mL', 'L']);
  });
});

describe('formatEntryQty', () => {
  it.each([
    [350_000, 'g', 'kg', '350'],
    [350_500, 'g', 'kg', '350,5'],
    [1_005, 'g', 'kg', '1,005'],
    [999, 'g', 'kg', '0,999'],
    [350_000, 'g', 't', '0,35'],
    [180, 'L', 'L', '180'],
  ] as const)('%i %s in %s → %s', (qty, base, unit, expected) => {
    expect(formatEntryQty(qty, base, unit)).toBe(expected);
  });

  it('round-trips any integer quantity in the default unit, and whole-kg quantities in tonnes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000_000_000 }), (qty) => {
        expect(parseEntryQty(formatEntryQty(qty, 'g', 'kg'), 'g', 'kg')).toEqual({ ok: true, value: qty });
        const kgs = qty * 1000;
        expect(parseEntryQty(formatEntryQty(kgs, 'g', 't'), 'g', 't')).toEqual({ ok: true, value: kgs });
      }),
    );
  });
});

describe('magnitudeWarnings', () => {
  const previous = [
    { componentId: 'cement', qtyPerM3: 350_000 },
    { componentId: 'water', qtyPerM3: 180 },
  ];

  it('flags a value 10x too big or 10x too small versus the previous version', () => {
    expect(magnitudeWarnings([{ componentId: 'cement', qtyPerM3: 3_500_000 }], previous)).toEqual(['cement']);
    expect(magnitudeWarnings([{ componentId: 'cement', qtyPerM3: 35_000 }], previous)).toEqual(['cement']);
    expect(magnitudeWarnings([{ componentId: 'water', qtyPerM3: 18 }], previous)).toEqual(['water']);
  });

  it('is quiet for ordinary changes, new components and a first version', () => {
    expect(magnitudeWarnings([{ componentId: 'cement', qtyPerM3: 380_000 }], previous)).toEqual([]);
    expect(magnitudeWarnings([{ componentId: 'cement', qtyPerM3: 349_999 }], previous)).toEqual([]);
    expect(magnitudeWarnings([{ componentId: 'sand', qtyPerM3: 1 }], previous)).toEqual([]);
    expect(magnitudeWarnings([{ componentId: 'cement', qtyPerM3: 1 }], [])).toEqual([]);
  });

  it('typing kilograms where grams are expected (or the reverse) is caught', () => {
    // 350 entered as grams instead of kg: 350 g vs 350 000 g.
    expect(magnitudeWarnings([{ componentId: 'cement', qtyPerM3: 350 }], previous)).toEqual(['cement']);
  });
});
