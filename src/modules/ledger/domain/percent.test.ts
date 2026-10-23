import { describe, expect, it } from 'vitest';
import { formatPercentBp, parsePercentBp } from './percent';

describe('percent', () => {
  it.each([
    ['40', 4000],
    ['33,33', 3333],
    ['12.5', 1250],
    ['100', 10_000],
    [' 7 ', 700],
    ['0,01', 1],
  ])('parses %s', (text, bp) => expect(parsePercentBp(text)).toBe(bp));

  it.each(['', '0', '100,01', '101', '-5', '1e2', '33,333', 'abc'])('refuses %j', (text) => {
    expect(parsePercentBp(text)).toBeNull();
  });

  it('formats basis points', () => {
    expect(formatPercentBp(4000)).toBe('40');
    expect(formatPercentBp(3333)).toBe('33,33');
    expect(formatPercentBp(1250)).toBe('12,5');
    expect(formatPercentBp(10_000)).toBe('100');
  });
});
