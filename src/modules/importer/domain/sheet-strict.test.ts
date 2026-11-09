import { describe, expect, it } from 'vitest';
import { buildWorkbook } from './xlsx-writer';
import { readCsv, readWorkbook, readXlsxSheets, SheetError, toRecords } from './sheet';

// R14-04: strictness of the reader. Synthetic workbooks only.
describe('the 1904 date system (R14-04)', () => {
  const rows = [['Date'], [43000]];
  it('a 1900-system workbook reads', () => {
    expect(readXlsxSheets(buildWorkbook([{ name: 'S', rows }]))[0]?.rows[1]).toEqual(['43000']);
  });
  it('a 1904-system workbook is refused before any cell is read, with the way out', () => {
    const f = buildWorkbook([{ name: 'S', rows }], false, { date1904: true });
    expect(() => readWorkbook(f)).toThrow(SheetError);
    expect(() => readWorkbook(f)).toThrow(/1904 date system/);
  });
});

describe('R15B-08: the 1904 flag is refused in every valid XML spelling', () => {
  const rows = [['Date'], [43000]];
  it.each([
    ['single quotes', "<workbookPr date1904='1'/>"],
    ['a namespace prefix', '<x:workbookPr date1904="1"/>'],
    ['a prefix and single quotes', "<x:workbookPr date1904='true'/>"],
    ['spaces around the equals sign', '<workbookPr date1904 = "1"/>'],
    ['a numeric character reference', '<workbookPr date1904="&#49;"/>'],
    ['a hexadecimal character reference', "<workbookPr date1904='&#x31;'/>"],
    ['the word true in capitals', '<workbookPr date1904="TRUE"/>'],
    ['another attribute first', '<workbookPr defaultThemeVersion="1" date1904="1"></workbookPr>'],
    ['an attribute that is a prefixed name', '<workbookPr x:date1904="1"/>'],
  ])('refuses %s', (_n, pr) => {
    const f = buildWorkbook([{ name: 'S', rows }], false, { workbookPr: pr });
    expect(() => readXlsxSheets(f)).toThrow(/1904 date system/);
  });
  it.each([
    ['explicit false', '<workbookPr date1904="0"/>'],
    ['explicit false in single quotes', "<workbookPr date1904='false'/>"],
    ['no flag at all', '<workbookPr defaultThemeVersion="1"/>'],
  ])('still reads a 1900-system workbook: %s', (_n, pr) => {
    expect(
      readXlsxSheets(buildWorkbook([{ name: 'S', rows }], false, { workbookPr: pr }))[0]?.rows[1],
    ).toEqual(['43000']);
  });
  it('refuses a flag whose value is not a plain boolean instead of guessing', () => {
    const f = buildWorkbook([{ name: 'S', rows }], false, { workbookPr: '<workbookPr date1904="maybe"/>' });
    expect(() => readXlsxSheets(f)).toThrow(/1904 date system|date system/);
  });
});

describe('duplicate accepted headers (R14-04)', () => {
  const cols = { name: ['Nom', 'Client'], city: ['Ville'] };
  it('one column per field reads; two columns with an accepted header for the same field are reported, not guessed', () => {
    const ok = toRecords(
      [
        ['Nom', 'Ville'],
        ['A', 'T'],
      ],
      cols,
    );
    expect(ok.ambiguous).toEqual([]);
    expect(ok.records[0]?.values).toEqual({ name: 'A', city: 'T' });
    const dup = toRecords(
      [
        ['Nom', 'Client', 'Ville'],
        ['A', 'B', 'T'],
      ],
      cols,
    );
    expect(dup.ambiguous).toEqual(['name']);
    const same = toRecords(
      [
        ['Nom', 'nom', 'Ville'],
        ['A', 'B', 'T'],
      ],
      cols,
    ); // accents and case are ignored, so these are the same header
    expect(same.ambiguous).toEqual(['name']);
  });
});

describe('malformed CSV (R14-04)', () => {
  it('a quote that is never closed is refused', () => {
    expect(() => readCsv('Nom;Ville\n"Ali;Tétouan\nB;Chefchaouen\n')).toThrow(/never closed/);
  });
  it('a well-formed quoted cell (with a doubled quote and a delimiter inside) still reads', () => {
    expect(readCsv('Nom;Ville\n"A ""x""; y";T\n')).toEqual([
      ['Nom', 'Ville'],
      ['A "x"; y', 'T'],
    ]);
  });
});

describe('formula cells are counted, never evaluated (R14-04)', () => {
  it('a sheet with a formula reports its count and gives the cached value as the cell', () => {
    const f = buildWorkbook([
      { name: 'S', rows: [['Montant'], [{ f: 'A1*2', v: 10 }], [{ f: '"x"&"y"', v: 'xy' }], [5]] },
    ]);
    const s = readXlsxSheets(f)[0]!;
    expect(s.formulaCells).toBe(2);
    expect(s.rows.slice(1)).toEqual([['10'], ['xy'], ['5']]);
  });
  it('a sheet with none says 0', () => {
    expect(readXlsxSheets(buildWorkbook([{ name: 'S', rows: [['a'], ['b']] }]))[0]?.formulaCells).toBe(0);
  });
});
