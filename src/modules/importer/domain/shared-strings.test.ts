import { describe, expect, it } from 'vitest';
import { readXlsxSheets } from './sheet';
import { buildXlsx, type PackageEdit } from './xlsx-writer';
import { readSet } from '../history/service/read-set';
import type { HistoryMapping } from '../history/domain/mapping';

// R19-09: the shared strings come from the workbook's OWN relationship. A relocated table is read where the workbook says; a decoy at the usual name is
// not read; zero or two relationships, a missing or non-table part, and a cell that points outside the table are refused before any sheet is parsed;
// no diagnostic carries a package part name or a sheet name.
const rows = [
  ['CLIENTS', 'M3'],
  ['REAL LABEL', 5],
];
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'xl/_rels/workbook.xml.rels';
const sst = (...s: string[]) =>
  `<?xml version="1.0"?><sst>${s.map((x) => `<si><t>${x}</t></si>`).join('')}</sst>`;
const edit =
  (f: (parts: Map<string, string>) => void): PackageEdit =>
  (e) => {
    const m = new Map(e);
    f(m);
    return [...m.entries()];
  };
const relocated = edit((m) => {
  const strings = m.get('xl/sharedStrings.xml')!;
  m.delete('xl/sharedStrings.xml');
  m.set('xl/tables/strings-A1.xml', strings); // the real table, somewhere else
  m.set('xl/sharedStrings.xml', sst('DECOY ONE', 'DECOY TWO', 'DECOY THREE')); // a decoy at the canonical name
  m.set(RELS, m.get(RELS)!.replace('Target="sharedStrings.xml"', 'Target="tables/strings-A1.xml"'));
});

describe('R19-09: the shared strings are the ones the workbook names', () => {
  it('control: the ordinary layout reads its own labels', () => {
    expect(readXlsxSheets(buildXlsx(rows))[0]?.rows).toEqual([
      ['CLIENTS', 'M3'],
      ['REAL LABEL', '5'],
    ]);
  });

  it('a relocated table is read where the workbook says; the decoy at the canonical name is NOT read', () => {
    expect(readXlsxSheets(buildXlsx(rows, { edit: relocated }))[0]?.rows).toEqual([
      ['CLIENTS', 'M3'],
      ['REAL LABEL', '5'],
    ]);
  });

  it('indexed cells with NO relationship are refused even though a canonical part exists (nothing is read from a name)', () => {
    const none = edit((m) => m.set(RELS, m.get(RELS)!.replace(/<Relationship Id="rId2"[^>]*\/>/, '')));
    expect(() => readXlsxSheets(buildXlsx(rows, { edit: none }))).toThrow(/does not hold/);
  });

  it('two shared-strings relationships are refused', () => {
    const two = edit((m) =>
      m.set(
        RELS,
        m
          .get(RELS)!
          .replace(
            '</Relationships>',
            `<Relationship Id="rId3" Type="${REL}/sharedStrings" Target="other.xml"/></Relationships>`,
          ),
      ),
    );
    expect(() => readXlsxSheets(buildXlsx(rows, { edit: two }))).toThrow(/more than one shared strings/);
  });

  it('a named part that is missing, or is not a string table, or a cell beyond the table, is refused', () => {
    const missing = edit((m) => m.delete('xl/sharedStrings.xml'));
    expect(() => readXlsxSheets(buildXlsx(rows, { edit: missing }))).toThrow(
      /shared strings part named by the workbook is missing/,
    );
    const notTable = edit((m) => m.set('xl/sharedStrings.xml', '<?xml version="1.0"?><other/>'));
    expect(() => readXlsxSheets(buildXlsx(rows, { edit: notTable }))).toThrow(/not a string table/);
    const short = edit((m) => m.set('xl/sharedStrings.xml', sst('ONLY ONE')));
    expect(() => readXlsxSheets(buildXlsx(rows, { edit: short }))).toThrow(/does not hold/);
  });

  it('no diagnostic carries a part name or a sheet name', () => {
    const SECRET = 'SECRETSHEETNAME';
    const named = (e: PackageEdit): Buffer =>
      buildXlsx(rows, {
        edit: (parts) =>
          e(
            parts.map(
              ([n, c]) => [n, n === 'xl/workbook.xml' ? c.replace('Sheet1', SECRET) : c] as [string, string],
            ),
          ),
      });
    const cases: Buffer[] = [
      named(edit((m) => m.delete('xl/sharedStrings.xml'))),
      named(edit((m) => m.delete('xl/worksheets/sheet1.xml'))),
      named(edit((m) => m.delete('xl/workbook.xml'))),
      named(
        edit((m) =>
          m.set(
            RELS,
            m
              .get(RELS)!
              .replace(
                '</Relationships>',
                `<Relationship Id="rId2" Type="${REL}/x" Target="y"/></Relationships>`,
              ),
          ),
        ),
      ),
    ];
    for (const buf of cases) {
      let msg = '';
      try {
        readXlsxSheets(buf);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe('');
      for (const forbidden of [SECRET, 'sharedStrings', 'sheet1', 'workbook.xml', 'rId2', 'xl/'])
        expect(msg).not.toContain(forbidden);
    }
  });

  it('the history reader reports the refusal with a fixed phrase and no name', () => {
    const mapping = {
      version: 1,
      kind: 'deliveries',
      plant: 'BELGO',
      plantCode: null,
      sheet: 'Sheet1',
      headerRow: 1,
      dateFormat: 'dmy',
      columns: {},
      legacyColumns: [],
      blankHeaderField: null,
      includeSheets: [],
      fileMonths: {},
    } as HistoryMapping;
    const bad = buildXlsx(rows, { edit: edit((m) => m.delete('xl/sharedStrings.xml')) });
    const r = readSet([{ ord: 1, buf: bad }], mapping);
    expect(r.files[0]?.problems).toEqual([
      'FILE_UNREADABLE: this file is not a readable workbook (the shared strings part named by the workbook is missing); open it in Excel and save it again as .xlsx',
    ]);
    expect(JSON.stringify(r.files)).not.toMatch(/sharedStrings|sheet1|Sheet1/);
    // the relocated, valid package is read by the same reader with the right labels
    const ok = readSet(
      [
        {
          ord: 1,
          buf: buildXlsx(
            [
              ['DATE', 'CLIENTS', 'M3'],
              [46083, 'REAL LABEL', 5],
            ],
            { edit: relocated },
          ),
        },
      ],
      mapping,
    );
    expect(ok.files[0]?.problems).not.toContain(expect.stringMatching(/UNREADABLE/));
  });
});
