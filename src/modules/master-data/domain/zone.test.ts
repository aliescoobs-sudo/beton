import { describe, expect, it } from 'vitest';
import { parseZoneInput } from './zone';

describe('parseZoneInput', () => {
  it('trims and collapses spaces in the name', () => {
    expect(parseZoneInput({ name: '  Oued   Laou ', oneWayMin: 60 })).toEqual({
      ok: true,
      value: { name: 'Oued Laou', oneWayMin: 60 },
    });
  });

  it('accepts Arabic names', () => {
    expect(parseZoneInput({ name: 'تطوان', oneWayMin: 20 }).ok).toBe(true);
  });

  it.each([
    [{ name: '', oneWayMin: 20 }],
    [{ name: '   ', oneWayMin: 20 }],
    [{ name: 'x'.repeat(81), oneWayMin: 20 }],
    [{ name: 'Martil', oneWayMin: 0 }],
    [{ name: 'Martil', oneWayMin: 481 }],
    [{ name: 'Martil', oneWayMin: 25.5 }],
    [{ name: 'Martil', oneWayMin: '25' }],
    [{ name: 42, oneWayMin: 25 }],
    [null],
    [{}],
  ])('refuses %j', (input) => {
    expect(parseZoneInput(input)).toEqual({ ok: false, error: 'INVALID' });
  });
});
