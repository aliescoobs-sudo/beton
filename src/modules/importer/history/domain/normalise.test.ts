import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PUMP_ALIASES,
  blNumber,
  blSuspect,
  categoryKey,
  clientKey,
  litresInText,
  parseVolumeM3,
  pumpKey,
  similarityGroups,
  taxBasisOf,
  taxBasisOfRow,
  truckKey,
  typeKey,
  withinOneEdit,
} from './normalise';

describe('history normalisers', () => {
  it('concrete type spellings share one key; an unknown spelling keeps its own key (never guessed)', () => {
    expect(['B25 ', 'B 25', 'b25', 'B25'].map(typeKey)).toEqual(['B25', 'B25', 'B25', 'B25']);
    expect(typeKey('BB25')).toBe('BB25');
    expect(typeKey('B25HYD')).toBe('B25HYD');
    expect(new Set(['B26', 'B27'].map(typeKey)).size).toBe(2);
  });

  it('pump: the built-in table knows POMPE, P, GOULOTTE, G; "P SITRAD" and anything else is for the owner', () => {
    expect(BUILTIN_PUMP_ALIASES[pumpKey(' pompe ')]).toBe('pump');
    expect(BUILTIN_PUMP_ALIASES[pumpKey('P')]).toBe('pump');
    expect(BUILTIN_PUMP_ALIASES[pumpKey('Goulotte')]).toBe('chute');
    expect(BUILTIN_PUMP_ALIASES[pumpKey('G')]).toBe('chute');
    expect(BUILTIN_PUMP_ALIASES[pumpKey('P SITRAD')]).toBeUndefined();
  });

  it('truck: spacing, dashes and case do not matter; a numeric internal code is its own key', () => {
    expect(truckKey('FX 1001')).toBe(truckKey('fx-1001'));
    expect(truckKey('FX1001')).toBe(truckKey('FX 1001'));
    expect(truckKey('7')).not.toBe(truckKey('FX 1001'));
  });

  it('client: trailing digits and spacing make different keys, grouped by similarity but never merged', () => {
    expect(clientKey('Kari  FICTIF')).toBe(clientKey('KARI FICTIF'));
    expect(clientKey('KARI FICTIF 1')).not.toBe(clientKey('KARI FICTIF'));
    const groups = similarityGroups([
      'KARI FICTIF',
      'KARI FICTIF 1',
      'KARI FICTIF 2',
      'ZUMO FICTIF',
      'KRAI FICTIF',
    ]);
    expect(groups.some((g) => g.includes('KARI FICTIF') && g.includes('KARI FICTIF 2'))).toBe(true);
    expect(groups.flat()).not.toContain('ZUMO FICTIF');
    expect(withinOneEdit('KARIMA', 'KARIMO')).toBe(true);
    expect(withinOneEdit('KARIMA', 'SALIMA')).toBe(false);
  });

  it('litres written in an imputation become integer millilitres; the category key drops them', () => {
    expect(litresInText('GASOIL 84,22 L')).toBe(84_220);
    expect(litresInText('gasoil 100 litres')).toBe(100_000);
    expect(litresInText('GASOIL')).toBeNull();
    expect(litresInText('PNEU 12')).toBeNull();
    expect(categoryKey('GASOIL 84,22 L')).toBe('GASOIL');
    expect(categoryKey('Gasoil')).toBe('GASOIL');
  });

  it('HT/TTC: the cell first; the adjuvant only when the cell is empty and says exactly HT or TTC; otherwise null', () => {
    expect(taxBasisOf('ttc')).toBe('TTC');
    expect(taxBasisOf('H.T')).toBe('HT');
    expect(taxBasisOfRow('HT', 'TTC')).toBe('HT');
    expect(taxBasisOfRow('', 'TTC')).toBe('TTC');
    expect(taxBasisOfRow('', 'HT')).toBe('HT');
    expect(taxBasisOfRow('', 'PLASTIFIANT')).toBeNull();
    expect(taxBasisOfRow('???', 'TTC')).toBeNull();
    expect(taxBasisOfRow('', '')).toBeNull();
  });

  it('m³ to integer litres: at most three decimals, spreadsheet residue rounded, anything else refused', () => {
    expect(parseVolumeM3('8')).toEqual({ ok: true, litres: 8000 });
    expect(parseVolumeM3('7,5')).toEqual({ ok: true, litres: 7500 });
    expect(parseVolumeM3('7.125')).toEqual({ ok: true, litres: 7125 });
    expect(parseVolumeM3('7.2000000000000002')).toEqual({ ok: true, litres: 7200 });
    expect(parseVolumeM3('7.4999999999999991')).toEqual({ ok: true, litres: 7500 });
    expect(parseVolumeM3('')).toEqual({ ok: false, reason: 'NO_VOLUME' });
    for (const bad of ['0', '-3', 'abc', '7.1234', '1e3', '7 m3'])
      expect(parseVolumeM3(bad), bad).toEqual({ ok: false, reason: 'BAD_VOLUME' });
  });

  it('delivery note values stay raw; a conversion garbage value is flagged suspect', () => {
    expect(blNumber('1234')).toBe(1234);
    expect(blNumber('1234.0')).toBe(1234);
    expect(blNumber('A12')).toBeNull();
    expect(blSuspect('922337203685')).toBe(true);
    expect(blSuspect('2500')).toBe(false);
    expect(blSuspect('A12')).toBe(false);
  });
});
