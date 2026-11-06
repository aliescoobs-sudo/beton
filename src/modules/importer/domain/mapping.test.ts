import { describe, expect, it } from 'vitest';
import { mappingForSheet, parseMapping, type SheetMapping } from './mapping';

const fields = () => ['name', 'kind', 'ice'];
const good = JSON.stringify({
  version: 1,
  sheet: 'Liste clients',
  kind: 'clients',
  headerRow: 3,
  dateFormat: 'dmy',
  columns: { name: ['Raison sociale', 'Désignation'], ice: 'N° ICE' },
});

describe('a mapping file describes one sheet', () => {
  it('reads the sheet, the kind, the header row and the header names (a single name or a list)', () => {
    const r = parseMapping(good, fields);
    expect(r).toMatchObject({ ok: true, value: { kind: 'clients', headerRow: 3, dateFormat: 'dmy' } });
    if (r.ok) expect(r.value.columns).toEqual({ name: ['Raison sociale', 'Désignation'], ice: ['N° ICE'] });
  });
  it('defaults: header on row 1, dates day first, no column renamed', () => {
    const r = parseMapping(JSON.stringify({ version: 1, sheet: '*', kind: 'clients' }), fields);
    expect(r).toMatchObject({ ok: true, value: { headerRow: 1, dateFormat: 'dmy', columns: {} } });
  });
  it.each([
    ['not json', '{', /not valid JSON/],
    ['a wrong version', JSON.stringify({ version: 2, sheet: 'a', kind: 'clients' }), /version/],
    ['an unknown kind', JSON.stringify({ version: 1, sheet: 'a', kind: 'salaries' }), /kind/],
    ['an unknown key', JSON.stringify({ version: 1, sheet: 'a', kind: 'clients', mapp: {} }), /mapp/],
    [
      'an unknown field',
      JSON.stringify({ version: 1, sheet: 'a', kind: 'clients', columns: { nmae: 'x' } }),
      /columns\.nmae/,
    ],
    [
      'an unknown date order',
      JSON.stringify({ version: 1, sheet: 'a', kind: 'clients', dateFormat: 'ymd' }),
      /dateFormat/,
    ],
    [
      'an empty header name',
      JSON.stringify({ version: 1, sheet: 'a', kind: 'clients', columns: { name: [''] } }),
      /columns/,
    ],
  ])('refuses %s', (_n, text, why) => {
    const r = parseMapping(text, fields);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toMatch(why);
  });
});

describe('which mapping applies to a sheet', () => {
  const m = (sheet: string): SheetMapping => ({
    version: 1,
    sheet,
    kind: 'clients',
    headerRow: 1,
    dateFormat: 'dmy',
    columns: {},
  });
  it('matches the sheet name ignoring case and accents; "*" only for a workbook of one sheet', () => {
    expect(mappingForSheet([m('Clients')], 'CLIENTS', 3)).toBeDefined();
    expect(mappingForSheet([m('Société')], 'societe', 3)).toBeDefined();
    expect(mappingForSheet([m('Clients')], 'Fournisseurs', 3)).toBeUndefined();
    expect(mappingForSheet([m('*')], 'csv', 1)).toBeDefined();
    expect(mappingForSheet([m('*')], 'Clients', 2)).toBeUndefined();
  });
});
