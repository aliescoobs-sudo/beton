import { describe, expect, it } from 'vitest';
import { formatMl, parseLitresToMl } from './cost-input';

describe('litres typed by a person', () => {
  it('become integer millilitres, at most three decimals, no sign', () => {
    expect(parseLitresToMl('22')).toBe(22_000);
    expect(parseLitresToMl('22,5')).toBe(22_500);
    expect(parseLitresToMl('0.073')).toBe(73);
    expect(parseLitresToMl('1 250,25')).toBe(1_250_250);
    for (const bad of ['', '-1', '1,2345', 'a', '1,,2', '12345678'])
      expect(parseLitresToMl(bad), bad).toBeNull();
  });
  it('are shown back without noise', () => {
    expect(formatMl(22_000)).toBe('22');
    expect(formatMl(22_250)).toBe('22,25');
    expect(formatMl(73)).toBe('0,073');
  });
});
