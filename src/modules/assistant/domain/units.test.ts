import { describe, expect, it } from 'vitest';
import { daysBetweenIso, displayQuantity, isIsoDate, litresToM3, minutesToClock } from './units';

describe('units the tools speak in', () => {
  it('converts litres to m³ to the litre', () => {
    expect(litresToM3(7500)).toBe(7.5);
    expect(litresToM3(7001)).toBe(7.001);
    expect(litresToM3(0)).toBe(0);
  });

  it('writes minutes as a clock time', () => {
    expect(minutesToClock(420)).toBe('07:00');
    expect(minutesToClock(485)).toBe('08:05');
    expect(minutesToClock(1500)).toBe('01:00');
  });

  it('puts stock in tonnes and litres, never in six-digit grams', () => {
    expect(displayQuantity(1_750_000, 'g')).toEqual({ value: 1.75, unit: 't' });
    expect(displayQuantity(-4_000_000, 'g')).toEqual({ value: -4, unit: 't' });
    expect(displayQuantity(2_500, 'mL')).toEqual({ value: 2.5, unit: 'L' });
    expect(displayQuantity(120, 'L')).toEqual({ value: 120, unit: 'L' });
  });

  it('counts days between ISO dates and knows a real date', () => {
    expect(daysBetweenIso('2026-06-01', '2026-06-10')).toBe(9);
    expect(daysBetweenIso('2026-06-10', '2026-06-01')).toBe(-9);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate("2026-02-28'; --")).toBe(false);
  });
});
