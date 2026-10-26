import { describe, expect, it } from 'vitest';
import { allowedFrom, canonicalNumber, checkNumbers } from './numbers-check';

const results = [
  {
    count: 3,
    rows: [
      {
        bl: 'BL-2026-00012',
        client: 'CLT-017',
        volumeM3: 7.5,
        date: '2026-10-26',
        at: '08:40',
        openAmount: '{{AMT_1}}',
      },
      {
        bl: 'BL-2026-00013',
        client: 'CLT-003',
        volumeM3: 12,
        date: '2026-10-26',
        at: '09:15',
        openAmount: '{{AMT_2}}',
      },
    ],
    coverDays: '4.5',
  },
];
const allowed = allowedFrom(results, 'et pour CLT-017 ?');

describe('canonical numbers', () => {
  it.each([
    ['7,50', '7.5'],
    ['7.5', '7.5'],
    ['1 250', '1250'],
    ['1.250', '1250'],
    ['٣', '3'],
    ['12', '12'],
  ])('%s is %s', (raw, expected) => expect(canonicalNumber(raw)).toBe(expected));
});

describe('the numbers post-check (AC-ASSIST-07)', () => {
  it('accepts placeholders, codes, dates, times and quantities of the tool results', () => {
    const text =
      'CLT-017 : BL-2026-00012 de 7,5 m³ le 2026-10-26 à 08:40, reste {{AMT_1}}. 3 livraisons, 12 m³, couverture 4,5 jours. Le 26/10/2026 à 9h15.';
    expect(checkNumbers(text, allowed)).toEqual({ ok: true, rejected: 0 });
  });

  it('accepts a code that only the question carried', () => {
    expect(checkNumbers('Pour CLT-017 : rien.', allowedFrom([], 'et pour CLT-017 ?')).ok).toBe(true);
  });

  it('rejects a sum, a percentage, a rounded figure and a figure from the question', () => {
    expect(checkNumbers('Au total 19,5 m³.', allowed).ok).toBe(false);
    expect(checkNumbers('soit 15 % du carnet', allowed).ok).toBe(false);
    expect(checkNumbers('environ 8 m³', allowed).ok).toBe(false);
    expect(checkNumbers('520 000 dh', allowed).ok).toBe(false);
    expect(checkNumbers('520 000', allowed).rejected).toBe(1);
  });

  it('rejects a code, a date or a time no tool returned', () => {
    expect(checkNumbers('BL-2026-00099', allowed).ok).toBe(false);
    expect(checkNumbers('le 2026-11-02', allowed).ok).toBe(false);
    expect(checkNumbers('à 10:05', allowed).ok).toBe(false);
    expect(checkNumbers('le 27/10/2026', allowed).ok).toBe(false);
  });

  it('does not count a number only because it is a part of a date or of a code', () => {
    expect(checkNumbers('26 m³', allowed).ok).toBe(false);
    expect(checkNumbers('00099 m³', allowed).ok).toBe(false);
  });

  it('reads Arabic-Indic digits like Latin ones', () => {
    expect(checkNumbers('٧٫٥ م³', allowed).ok).toBe(false);
    expect(checkNumbers('١٢ م³', allowed).ok).toBe(true);
    expect(checkNumbers('٩٩ م³', allowed).ok).toBe(false);
  });

  it('never reports the rejected values', () => {
    expect(JSON.stringify(checkNumbers('987654 m³', allowed))).not.toContain('987654');
  });
});
