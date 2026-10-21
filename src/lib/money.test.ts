import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes, formatCentimes, mulDivRound, parseCentimes } from './money';

describe('centimes', () => {
  it('accepts safe integers and refuses fractions, NaN and unsafe values', () => {
    expect(centimes(362_500)).toBe(362_500);
    expect(() => centimes(1.5)).toThrow(RangeError);
    expect(() => centimes(Number.NaN)).toThrow(RangeError);
    expect(() => centimes(2 ** 60)).toThrow(RangeError);
  });
});

describe('mulDivRound', () => {
  it.each([
    [10, 1, 4, 3], // 2.5 → 3
    [10, 1, 3, 3], // 3.33 → 3
    [-10, 1, 4, -3], // -2.5 → -3 (away from zero)
    [10, -1, 4, -3],
    [10, 1, -4, -3],
    [-10, -1, 4, 3],
    [10, 3, 5, 6],
    [0, 7, 3, 0],
  ])('%i × %i / %i = %i', (amount, num, den, expected) => {
    expect(mulDivRound(centimes(amount), num, den)).toBe(expected);
  });

  it('refuses a zero or non-integer denominator and a non-integer numerator', () => {
    expect(() => mulDivRound(centimes(1), 1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(centimes(1), 1, 0.5)).toThrow(RangeError);
    expect(() => mulDivRound(centimes(1), 0.5, 1)).toThrow(RangeError);
  });

  it('is exact on large operands where a float product would lose precision', () => {
    expect(mulDivRound(centimes(9_007_199_254_740), 1000, 1000)).toBe(9_007_199_254_740);
  });

  it('property: the result is an integer within half a centime of the exact quotient', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (amount, num, den) => {
          const result = mulDivRound(centimes(amount), num, den);
          expect(Number.isSafeInteger(result)).toBe(true);
          const diff = BigInt(result) * BigInt(den) * 2n - BigInt(amount) * BigInt(num) * 2n;
          expect((diff < 0n ? -diff : diff) <= BigInt(den)).toBe(true);
        },
      ),
    );
  });
});

describe('parseCentimes / formatCentimes', () => {
  it.each([
    ['1450', 145_000],
    ['1 450,5', 145_050],
    ['1450.00', 145_000],
    ['0,01', 1],
  ])('parses %s', (text, expected) => expect(parseCentimes(text)).toBe(expected));

  it.each(['', '-5', '1,234', '1e3', 'abc', '1.2.3'])('refuses %j', (text) =>
    expect(parseCentimes(text)).toBeNull(),
  );

  it('formats with a decimal comma and grouped thousands', () => {
    expect(formatCentimes(362_500)).toBe('3\u202f625,00');
    expect(formatCentimes(5)).toBe('0,05');
  });

  it('round-trips any whole amount of centimes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999_999 }), (n) => {
        expect(parseCentimes(formatCentimes(n))).toBe(n);
      }),
    );
  });
});
