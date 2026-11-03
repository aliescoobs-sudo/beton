import { describe, it, expect } from 'vitest';
import { financeAmount } from './input';
import { financeCommand } from '../service/commands';
describe('human financial input', () => {
  it('parses MAD once, with spaces and either decimal separator', () => {
    expect(financeAmount('1 234,56')).toBe(123456);
    expect(financeAmount('0')).toBe(0);
    expect(financeAmount('12.3')).toBe(1230);
  });
  it.each(['1e6', '-1', 'NaN', '0.001', '1.000,00', '1,2,3', '90071992547409999', ''])(
    'rejects %s',
    (value) => {
      expect(() => financeAmount(value)).toThrow();
    },
  );
  it('does not accept fractional, infinite or unsafe centimes in any command', () => {
    const v = { action: 'obligation', date: '2026-11-02', direction: 'out', reference: 'x', label: 'x' };
    for (const amountCentimes of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(financeCommand.safeParse({ ...v, amountCentimes }).success).toBe(false);
  });
});
