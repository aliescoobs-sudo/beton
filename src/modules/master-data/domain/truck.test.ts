import { describe, expect, it } from 'vitest';
import { formatCapacityM3, parseCapacityM3 } from './truck';

describe('truck capacity in m³ (stored in litres)', () => {
  it.each([
    ['8', 8000],
    ['8,5', 8500],
    ['8.5', 8500],
    ['8.25', 8250],
    [' 9 ', 9000],
    ['0,001', null],
    ['1', 1000],
    ['30', 30000],
    ['0.999', null],
    ['30.001', null],
    ['31', null],
    ['8.5555', null],
    ['', null],
    ['huit', null],
    ['-8', null],
    ['8 m3', null],
  ])('parses %j to %j litres', (text, litres) => {
    const parsed = parseCapacityM3(text);
    if (litres === null) expect(parsed).toEqual({ ok: false, error: 'INVALID' });
    else expect(parsed).toEqual({ ok: true, value: litres });
  });

  it('formats litres back to the same m³ text, with no float error', () => {
    expect(formatCapacityM3(8000)).toBe('8');
    expect(formatCapacityM3(8500)).toBe('8,5');
    expect(formatCapacityM3(8250)).toBe('8,25');
    expect(formatCapacityM3(8005)).toBe('8,005');
    for (let l = 1000; l <= 30000; l += 5) {
      expect(parseCapacityM3(formatCapacityM3(l))).toEqual({ ok: true, value: l });
    }
  });
});
