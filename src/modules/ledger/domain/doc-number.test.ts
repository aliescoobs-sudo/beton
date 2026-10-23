import { describe, expect, it } from 'vitest';
import { docYearOf, formatDocNumber } from './doc-number';

describe('document numbers', () => {
  it('formats prefix, year and a zero-padded counter', () => {
    expect(formatDocNumber('CMD', 2026, 1)).toBe('CMD-2026-00001');
    expect(formatDocNumber('FA', 2026, 12_345)).toBe('FA-2026-12345');
  });

  it('never truncates a number wider than the padding', () => {
    expect(formatDocNumber('ACH', 2027, 123_456)).toBe('ACH-2027-123456');
  });

  it('refuses a year or a number that cannot be a document number', () => {
    expect(() => formatDocNumber('CMD', 1999, 1)).toThrow(RangeError);
    expect(() => formatDocNumber('CMD', 2026, 0)).toThrow(RangeError);
    expect(() => formatDocNumber('CMD', 2026, 1.5)).toThrow(RangeError);
  });

  it('the numbering year is the business date year', () => {
    expect(docYearOf('2026-12-31')).toBe(2026);
    expect(docYearOf('2027-01-01')).toBe(2027);
    expect(() => docYearOf('31/12/2026')).toThrow(RangeError);
  });
});
