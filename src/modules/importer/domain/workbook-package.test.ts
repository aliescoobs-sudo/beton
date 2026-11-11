import { describe, expect, it } from 'vitest';
import { readWorkbook, readXlsxSheets } from './sheet';
import { buildWorkbook, buildXlsx, type PackageEdit } from './xlsx-writer';
import { parseXmlDocument, XmlFlagsError } from './xml-flags';

// R18-09: the calendar guard reads the AUTHORITATIVE workbook part, found through the package relationships; a package whose main part is
// somewhere else, missing, empty, malformed or doubled is refused before any worksheet is parsed.
const rows = [['Date'], [43000]];
const WB_1904 = `<?xml version="1.0"?><workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const build = (edit?: PackageEdit) => buildWorkbook([{ name: 'S', rows }], false, { edit });
const without =
  (name: string): PackageEdit =>
  (e) =>
    e.filter(([n]) => n !== name);
const replace =
  (name: string, content: string): PackageEdit =>
  (e) =>
    e.map(([n, c]) => [n, n === name ? content : c]);
const READ = /not a readable workbook|date system|1904/;

describe('R18-09: the main workbook part is the one the package says it is', () => {
  it('control: a valid 1900 package reads, every sheet resolved through the relationships', () => {
    expect(readXlsxSheets(build())[0]?.rows[1]).toEqual(['43000']);
    expect(readXlsxSheets(buildXlsx([['a'], [1]]))[0]?.rows).toEqual([['a'], ['1']]);
    expect(readWorkbook(build())[0]?.name).toBe('S');
  });

  it('a 1904 main part RELOCATED away from xl/workbook.xml (the root relationship points to it) is refused — the decoy xl/workbook.xml says 1900', () => {
    const relocated: PackageEdit = (e) => [
      ...e.map(([n, c]): [string, string] => [
        n,
        n === '_rels/.rels' ? c.replace('xl/workbook.xml', 'xl/other/main.xml') : c,
      ]),
      ['xl/other/main.xml', WB_1904.replace('rId1', 'rId1')],
      [
        'xl/other/_rels/main.xml.rels',
        e.find(([n]) => n === 'xl/_rels/workbook.xml.rels')![1].replace('worksheets/', '../worksheets/'),
      ],
    ];
    // before the fix the reader opened the decoy by NAME, saw 1900 and parsed the numbered sheets as dates of the wrong epoch
    expect(() => readXlsxSheets(build(relocated))).toThrow(/1904 date system/);
  });

  it('a missing main part is refused (no fallback to numbered worksheets)', () => {
    expect(() => readXlsxSheets(build(without('xl/workbook.xml')))).toThrow(READ);
    expect(() => readXlsxSheets(build(without('_rels/.rels')))).toThrow(/no _rels\/\.rels/);
    expect(() => readXlsxSheets(build(without('xl/_rels/workbook.xml.rels')))).toThrow(/no relationships/);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '  \n '],
    [
      'truncated',
      '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/>',
    ],
    ['mis-nested', '<workbook><sheets></workbook></sheets>'],
    ['not a workbook', '<?xml version="1.0"?><other/>'],
    ['two roots', '<workbook/><workbook/>'],
    ['text outside the root', 'junk<workbook/>'],
  ])('a %s main part is refused', (_n, xml) => {
    expect(() => readXlsxSheets(build(replace('xl/workbook.xml', xml)))).toThrow(READ);
  });

  it('a duplicate ZIP entry name is refused (the later may not silently replace the checked one), also with another case or a leading slash', () => {
    const dup =
      (name: string): PackageEdit =>
      (e) => [...e, [name, WB_1904]];
    expect(() => readXlsxSheets(build(dup('xl/workbook.xml')))).toThrow(/more than once/);
    expect(() => readXlsxSheets(build(dup('XL/Workbook.xml')))).toThrow(/more than once/);
    expect(() => readXlsxSheets(build(dup('/xl/workbook.xml')))).toThrow(/more than once/);
  });

  it('no officeDocument relationship, or two of them, is refused', () => {
    const none = replace('_rels/.rels', '<Relationships/>');
    expect(() => readXlsxSheets(build(none))).toThrow(/names no main workbook part/);
    const two = replace(
      '_rels/.rels',
      '<Relationships><Relationship Id="a" Type="http://x/officeDocument" Target="xl/workbook.xml"/><Relationship Id="b" Type="http://x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    );
    expect(() => readXlsxSheets(build(two))).toThrow(/more than one main/);
    const outside = replace(
      '_rels/.rels',
      '<Relationships><Relationship Id="a" Type="http://x/officeDocument" Target="../evil.xml"/></Relationships>',
    );
    expect(() => readXlsxSheets(build(outside))).toThrow(/leaves the package/);
  });

  it('a sheet without a usable relationship, a missing sheet part or a malformed relationships part is refused', () => {
    expect(() => readXlsxSheets(build(without('xl/worksheets/sheet1.xml')))).toThrow(/is missing/);
    expect(() =>
      readXlsxSheets(build(replace('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1"'))),
    ).toThrow(READ);
    expect(() => readXlsxSheets(build(replace('xl/_rels/workbook.xml.rels', '<Relationships/>')))).toThrow(
      /no usable relationship/,
    );
  });

  it('a worksheet part is never parsed when the main part is refused (a corrupt sheet does not change the answer)', () => {
    const bad: PackageEdit = (e) =>
      e.map(([n, c]) => [n, n === 'xl/workbook.xml' ? '' : n.startsWith('xl/worksheets/') ? '<<<' : c]);
    expect(() => readXlsxSheets(build(bad))).toThrow(/date system could not be determined \(an empty part\)/);
  });
});

describe('R18-09: parseXmlDocument verifies well-formedness', () => {
  it('accepts a complete document and reports nesting depth', () => {
    const tags = parseXmlDocument('<?xml version="1.0"?>\n<a x="1"><b/><c><d/></c></a>\n');
    expect(tags.map((t) => [t.name, t.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 1],
      ['d', 2],
    ]);
  });
  it.each([
    ['empty', ''],
    ['only a declaration', '<?xml version="1.0"?>'],
    ['an end tag with no start', '</a>'],
    ['a mismatched end tag', '<a><b></a></b>'],
    ['an element left open', '<a><b/>'],
    ['two roots', '<a/><b/>'],
    ['text after the root', '<a/>tail'],
    ['text before the root', 'head<a/>'],
  ])('refuses %s', (_n, xml) => {
    expect(() => parseXmlDocument(xml)).toThrow(XmlFlagsError);
  });
});
