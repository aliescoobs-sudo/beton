import { describe, expect, it } from 'vitest';
import { parseImportAmount, parseWholeNumber } from './values';

describe('amounts become integer centimes, or are refused', () => {
  it.each([
    ['1250', 125000],
    ['1 250,50', 125050],
    ['1250.5', 125050],
    ['0,05', 5],
    ['1 250', 125000],
  ])('%s -> %i', (text, cents) => {
    expect(parseImportAmount(text)).toEqual({ ok: true, value: cents });
  });
  it.each([
    ['', /empty/],
    ['-5', /negative/],
    ['(5)', /negative/],
    ['1,5E3', /scientific/],
    ['1,234', /ambiguous/],
    ['1.234', /ambiguous/],
    ['1.234,50', /ambiguous/],
    ['1,234,567', /ambiguous/],
    ['1234.4999999999998', /decimals/],
    ['12 MAD', /not an amount/],
    ['abc', /not an amount/],
  ])('refuses %j', (text, why) => {
    const r = parseImportAmount(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(why);
  });
});

describe('whole numbers', () => {
  it('reads 12 and 12.0, refuses 12.5, text and out-of-range', () => {
    expect(parseWholeNumber('12.0', 1, 99)).toEqual({ ok: true, value: 12 });
    expect(parseWholeNumber('12', 1, 99)).toEqual({ ok: true, value: 12 });
    expect(parseWholeNumber('12.5', 1, 99).ok).toBe(false);
    expect(parseWholeNumber('x', 1, 99).ok).toBe(false);
    expect(parseWholeNumber('100', 1, 99).ok).toBe(false);
  });
});
