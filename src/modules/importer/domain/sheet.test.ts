import { describe, expect, it } from 'vitest';
import { buildWorkbook, buildXlsx } from '../../../../tests/helpers/xlsx-writer';
import {
  readCsv,
  readSheet,
  readWorkbook,
  readXlsx,
  readXlsxSheets,
  SheetError,
  toIsoDate,
  toRecords,
} from './sheet';

describe('reading a workbook (AC-PROD-28)', () => {
  const rows = [
    ['Nom', 'Type', 'ICE'],
    ['Société Atlas & Fils', 'company', '001234567000089'],
    ['Ali <Test>', 'person', ''],
  ];
  it.each([
    ['stored shared strings', {}],
    ['deflated shared strings', { deflate: true }],
    ['inline strings', { inline: true }],
  ])('reads the cells of an .xlsx (%s), with entities decoded and empty cells kept', (_n, opts) => {
    const sheet = readXlsx(buildXlsx(rows, opts));
    expect(sheet).toEqual(rows);
    expect(readSheet(buildXlsx(rows, opts))).toEqual(rows);
  });
  it('keeps numbers as text and skips trailing empty rows', () => {
    expect(
      readXlsx(
        buildXlsx([
          ['a', 'b'],
          ['x', 12.5],
          ['', ''],
        ]),
      ),
    ).toEqual([
      ['a', 'b'],
      ['x', '12.5'],
    ]);
  });
  it('refuses what is not a workbook', () => {
    expect(() => readXlsx(Buffer.from('not a zip at all'))).toThrow(SheetError);
    expect(() => readXlsx(buildXlsx(rows), 3)).toThrow(/no such sheet/);
    const bomb = buildXlsx(rows, { deflate: true });
    // declare the sheet part as 30 MB once unpacked: the reader refuses before it inflates anything
    const sheetName = bomb.lastIndexOf(Buffer.from('xl/worksheets/sheet1.xml'));
    bomb.writeUInt32LE(30 * 1024 * 1024, sheetName - 46 + 24);
    expect(() => readXlsx(bomb)).toThrow(/too large/);
  });
});

describe('named sheets', () => {
  const sheets = [
    { name: 'Clients', rows: [['Nom'], ['Client Test A']] },
    {
      name: 'Prix & tarifs',
      rows: [
        ['Type', 'Prix'],
        ['B25', 780],
      ],
    },
  ];
  it('keeps the sheet names, in workbook order, and decodes them', () => {
    const read = readXlsxSheets(buildWorkbook(sheets));
    expect(read.map((s) => s.name)).toEqual(['Clients', 'Prix & tarifs']);
    expect(read[1]?.rows).toEqual([
      ['Type', 'Prix'],
      ['B25', '780'],
    ]);
    expect(readWorkbook(buildWorkbook(sheets, true)).map((s) => s.name)).toEqual([
      'Clients',
      'Prix & tarifs',
    ]);
  });
  it('names the sheets of a workbook without names Sheet1, Sheet2 and a CSV "csv"', () => {
    expect(readWorkbook(buildXlsx([['a']])).map((s) => s.name)).toEqual(['Sheet1']);
    expect(readWorkbook(Buffer.from('a;b\n1;2')).map((s) => s.name)).toEqual(['csv']);
  });
});

describe('reading a CSV', () => {
  it('handles semicolons, commas, quotes and a BOM', () => {
    expect(readCsv('﻿Nom;Montant\r\n"Atlas; fils";"1 250,50"\n')).toEqual([
      ['Nom', 'Montant'],
      ['Atlas; fils', '1 250,50'],
    ]);
    expect(readCsv('a,b\n"x ""y""",2')).toEqual([
      ['a', 'b'],
      ['x "y"', '2'],
    ]);
  });
  it('picks the format by content, not by name', () => {
    expect(readSheet(Buffer.from('a,b\n1,2'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('dates and headers', () => {
  it('understands an Excel serial, dd/mm/yyyy and ISO', () => {
    expect(toIsoDate('46023')).toBe('2026-01-01');
    expect(toIsoDate('5/1/2026')).toBe('2026-01-05');
    expect(toIsoDate('2026-03-09')).toBe('2026-03-09');
    expect(toIsoDate('soon')).toBeNull();
  });
  it('refuses a date that does not exist or can be read two ways, instead of guessing', () => {
    for (const bad of [
      '31/02/2026',
      '2026-02-30',
      '13/13/2026',
      '5/1/26',
      '01/02-2026',
      '2026-1-5',
      '12345',
      '99999',
    ])
      expect(toIsoDate(bad), bad).toBeNull();
    // the declared order decides: 03/04/2026 is 3 April in dmy, 4 March in mdy, and not a date at all in iso
    expect(toIsoDate('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(toIsoDate('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(toIsoDate('03/04/2026', 'iso')).toBeNull();
    expect(toIsoDate('25/04/2026', 'mdy')).toBeNull();
    expect(toIsoDate('2026-04-03', 'iso')).toBe('2026-04-03');
    expect(toIsoDate('29/02/2028')).toBe('2028-02-29');
    expect(toIsoDate('29/02/2027')).toBeNull();
  });
  it('maps headers by their accepted names, ignoring case and accents, and lists the missing ones', () => {
    const r = toRecords(
      [
        ['Raison Sociale', 'TÉLÉPHONE'],
        ['Atlas', '0661'],
        ['', ''],
      ],
      {
        name: ['name', 'raison sociale'],
        phone: ['phone', 'téléphone'],
        ice: ['ice'],
      },
    );
    expect(r.missing).toEqual(['ice']);
    expect(r.records).toEqual([{ row: 2, values: { name: 'Atlas', phone: '0661' } }]);
  });
});
