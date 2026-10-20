import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRecetteInput, resolveRecette } from './recette';

const v = (effectiveFrom: string, id = effectiveFrom) => ({ id, effectiveFrom });

describe('resolveRecette (AC-MD-02)', () => {
  const versions = [v('2026-01-01'), v('2026-06-01'), v('2026-09-15')];

  it('picks the latest version not after the date', () => {
    expect(resolveRecette(versions, '2026-05-31')).toEqual({ ok: true, value: v('2026-01-01') });
    expect(resolveRecette(versions, '2026-06-01')).toEqual({ ok: true, value: v('2026-06-01') });
    expect(resolveRecette(versions, '2030-01-01')).toEqual({ ok: true, value: v('2026-09-15') });
  });

  it('errors before the first version and on an empty list', () => {
    expect(resolveRecette(versions, '2025-12-31')).toEqual({ ok: false, error: 'NO_RECETTE' });
    expect(resolveRecette([], '2026-01-01')).toEqual({ ok: false, error: 'NO_RECETTE' });
  });

  it('a new version at D leaves every earlier date on the old version', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2040-01-01'), noInvalidDate: true }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2040-01-01'), noInvalidDate: true }),
        (d, probe) => {
          const day = (x: Date) => x.toISOString().slice(0, 10);
          const before = resolveRecette(versions, day(probe));
          const after = resolveRecette([...versions, v(day(d), 'new')], day(probe));
          if (day(probe) < day(d)) expect(after).toEqual(before);
          else if (day(d) > '2026-09-15' || day(probe) >= day(d)) expect(after.ok).toBe(true);
        },
      ),
    );
  });
});

describe('parseRecetteInput', () => {
  const id = '019c0000-0000-7000-8000-000000000001';
  it('accepts integer quantities and a real date', () => {
    expect(
      parseRecetteInput({ effectiveFrom: '2026-02-28', lines: [{ componentId: id, qtyPerM3: 350000 }] }).ok,
    ).toBe(true);
  });
  it.each([
    ['decimal quantity', { effectiveFrom: '2026-02-28', lines: [{ componentId: id, qtyPerM3: 1.5 }] }],
    ['zero quantity', { effectiveFrom: '2026-02-28', lines: [{ componentId: id, qtyPerM3: 0 }] }],
    ['no line', { effectiveFrom: '2026-02-28', lines: [] }],
    ['impossible date', { effectiveFrom: '2026-02-30', lines: [{ componentId: id, qtyPerM3: 1 }] }],
    [
      'duplicate component',
      {
        effectiveFrom: '2026-02-28',
        lines: [
          { componentId: id, qtyPerM3: 1 },
          { componentId: id, qtyPerM3: 2 },
        ],
      },
    ],
  ])('refuses %s', (_name, input) => {
    expect(parseRecetteInput(input)).toEqual({ ok: false, error: 'INVALID' });
  });
});
