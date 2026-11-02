import { describe, expect, it } from 'vitest';
import { buildXlsx } from '../../../../tests/helpers/xlsx-writer';
import { readCsv, readSheet, readXlsx, SheetError, toIsoDate, toRecords } from './sheet';

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
