import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes, type Centimes } from './money';
import { baseQty, costOf, type MilliQty, parseMilliQty, toBase } from './quantity';

function milli(text: string): MilliQty {
  const parsed = parseMilliQty(text);
  if (!parsed.ok) throw new Error(text);
  return parsed.value;
}

describe('parseMilliQty', () => {
  it.each([
    ['2.5', 2500],
    ['2,5', 2500],
    ['0,001', 1],
    ['12', 12_000],
    [' 8 ', 8000],
  ])('%s → %i', (text, expected) => {
    expect(parseMilliQty(text)).toEqual({ ok: true, value: expected });
  });

  it.each(['', '-1', '1e3', '1.2345', '1,', '.5', 'abc', '1 000'])('refuses %j', (text) => {
    expect(parseMilliQty(text)).toEqual({ ok: false, error: 'INVALID_QUANTITY' });
  });
});

describe('toBase', () => {
  it('AC-MD-04: 2,5 t of cement is 2 500 000 g', () => {
    expect(toBase(milli('2.5'), 1_000_000)).toEqual({ ok: true, value: 2_500_000 });
  });

  it('refuses a fractional base unit instead of rounding it', () => {
    expect(toBase(milli('0.5'), 1)).toEqual({ ok: false, error: 'FRACTIONAL_BASE_UNIT' });
    expect(toBase(milli('0.5'), 1000)).toEqual({ ok: true, value: 500 });
  });

  it('refuses a zero, negative or fractional factor', () => {
    for (const factor of [0, -1, 0.5])
      expect(toBase(milli('1'), factor)).toEqual({ ok: false, error: 'INVALID_FACTOR' });
  });
});

describe('costOf', () => {
  it('AC-MD-04: 2,5 t of cement at 1 450,00 MAD/t HT costs 3 625,00 MAD', () => {
    const qty = toBase(milli('2.5'), 1_000_000);
    if (!qty.ok) throw new Error('conversion');
    expect(costOf(qty.value, centimes(145_000), 1_000_000)).toBe(362_500);
  });

  it('property: the cost does not depend on the unit used to express the same quantity and price (±1 centime)', () => {
    // Same rate in two units: per tonne vs per kg (price and factor scaled together), same physical quantity.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }), // price per tonne, centimes
        fc.integer({ min: 1, max: 100_000 }), // quantity in kg
        (perTonne, kg) => {
          const grams = baseQty(kg * 1000);
          const viaTonne = costOf(grams, centimes(perTonne), 1_000_000);
          const viaKg = costOf(grams, centimes(perTonne * 1000), 1_000_000_000);
          expect(Math.abs(viaTonne - viaKg)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('property: always integer centimes, within half a centime of the exact cost', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom(1, 1000, 50_000, 1_000_000),
        (qty, price, factor) => {
          const cost: Centimes = costOf(baseQty(qty), centimes(price), factor);
          expect(Number.isSafeInteger(cost)).toBe(true);
          expect(Math.abs(cost * factor - qty * price)).toBeLessThanOrEqual(factor / 2);
        },
      ),
    );
  });
});
