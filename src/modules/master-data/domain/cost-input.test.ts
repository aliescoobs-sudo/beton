import { describe, expect, it } from 'vitest';
import { formatBp, formatMl, parseLitresToMl, parsePercentToBp } from './cost-input';

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

describe('T17 G11: the fuel check threshold as a percentage', () => {
  it('parses a typed percentage into integer basis points, refusing anything else', () => {
    expect(parsePercentToBp('10')).toBe(1000);
    expect(parsePercentToBp('7,5')).toBe(750);
    expect(parsePercentToBp('12.25')).toBe(1225);
    expect(parsePercentToBp('100')).toBe(10_000);
    for (const bad of ['0', '0,00', '100,01', '101', '-5', '1e1', '', 'dix', '5,123'])
      expect(parsePercentToBp(bad), bad).toBeNull();
  });
  it('formats basis points back', () => {
    expect(formatBp(1000)).toBe('10');
    expect(formatBp(750)).toBe('7,5');
    expect(formatBp(1225)).toBe('12,25');
  });
});
