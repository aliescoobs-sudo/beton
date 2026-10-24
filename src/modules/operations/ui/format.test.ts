import { describe, expect, it } from 'vitest';
import { formatM3, formatStockQty } from './format';

describe('operations formats', () => {
  it('m3 from litres', () => {
    expect(formatM3(8000)).toBe('8');
    expect(formatM3(7500)).toBe('7,5');
    expect(formatM3(0)).toBe('0');
  });
  it('stock quantity in kg or L', () => {
    expect(formatStockQty(30_000_000, 'g')).toEqual({ value: '30 000', unit: 'kg' });
    expect(formatStockQty(-2_800_000, 'g')).toEqual({ value: '-2 800', unit: 'kg' });
    expect(formatStockQty(1_500, 'mL')).toEqual({ value: '1,5', unit: 'L' });
    expect(formatStockQty(4200, 'L')).toEqual({ value: '4 200', unit: 'L' });
  });
});
