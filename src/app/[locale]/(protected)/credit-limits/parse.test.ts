import { describe, expect, it } from 'vitest';
import { madToCentimes } from './money';

describe('madToCentimes', () => {
  it('reads dirhams as integer centimes', () => {
    expect(madToCentimes('12 500,50')).toBe(1_250_050);
    expect(madToCentimes('12500.5')).toBe(1_250_050);
    expect(madToCentimes('300')).toBe(30_000);
    expect(madToCentimes('0,05')).toBe(5);
  });
  it('empty removes the limit; nonsense and zero are refused', () => {
    expect(madToCentimes('  ')).toBeNull();
    for (const bad of ['abc', '1,234', '-5', '0', '1e5', '12.345'])
      expect(madToCentimes(bad), bad).toBe('INVALID');
  });
});
