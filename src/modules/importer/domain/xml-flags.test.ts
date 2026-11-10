import { describe, expect, it } from 'vitest';
import { readXlsxSheets } from './sheet';
import { buildWorkbook } from './xlsx-writer';
import { MAX_WORKBOOK_XML, workbookUses1904, XmlFlagsError } from './xml-flags';

const rows = [['Date'], [43000]];
const wb = (pr: string) => buildWorkbook([{ name: 'S', rows }], false, { workbookPr: pr });
const permutations = <T>(xs: T[]): T[][] =>
  xs.length <= 1
    ? [xs]
    : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

describe('R17-05: the 1904 declaration is read by a tokenizer, not a regular expression', () => {
  it('the counterexample of the review: a ">" inside a quoted attribute before date1904', () => {
    expect(workbookUses1904('<workbookPr codeName=">" date1904="1"/>')).toBe(true);
    expect(() => readXlsxSheets(wb('<workbookPr codeName=">" date1904="1"/>'))).toThrow(/1904 date system/);
    // the review's file was read as a 1900 workbook; the same shape with the flag false still is
    expect(readXlsxSheets(wb('<workbookPr codeName=">" date1904="0"/>'))[0]?.rows[1]).toEqual(['43000']);
  });

  it.each(['"', "'"])(
    'every attribute order, with a ">" in a %s-quoted value, both quote styles on the flag',
    (q) => {
      const attrs = [`a=${q}x>y${q}`, `codeName=${q}>${q}`, `date1904=${q}1${q}`];
      for (const order of permutations(attrs)) {
        const tag = `<workbookPr ${order.join(' ')}/>`;
        expect(workbookUses1904(tag), tag).toBe(true);
        expect(() => readXlsxSheets(wb(tag)), tag).toThrow(/1904 date system/);
        const other = tag.replace(`date1904=${q}1${q}`, `date1904=${q}0${q}`);
        expect(workbookUses1904(other), other).toBe(false);
      }
    },
  );

  it('opposite quote characters inside a value, entities, prefixes, an end-tag form and spaces', () => {
    for (const tag of [
      `<workbookPr a='"' date1904="1"/>`,
      `<workbookPr a="'>'" date1904='1'></workbookPr>`,
      `<workbookPr a="&gt;&amp;" date1904="&#x31;"/>`,
      `<x:workbookPr x:a=">" x:date1904="true"/>`,
      `<workbookPr\n  a=">"\n  date1904\n=\n"1"\n/>`,
      `<ns0:workbookPr a="&lt;" date1904='  1 '/>`,
    ])
      expect(workbookUses1904(tag), tag).toBe(true);
    for (const tag of [
      `<workbookPr a='"' date1904="0"/>`,
      `<workbookPr a="&gt;" date1904="false"/>`,
      `<workbookPr a=">"/>`,
      `<other date1904="1"/>`,
      `<root/>`,
      ``,
    ])
      expect(workbookUses1904(tag), tag).toBe(false);
  });

  it('comments, CDATA and processing instructions are skipped as units (text that looks like the flag is not the flag)', () => {
    expect(workbookUses1904('<!-- <workbookPr date1904="1"/> --><workbookPr date1904="0"/>')).toBe(false);
    expect(workbookUses1904('<!-- a > b --><workbookPr codeName=">" date1904="1"/>')).toBe(true);
    expect(workbookUses1904('<a><![CDATA[<workbookPr date1904="1"/> > ]]></a><workbookPr/>')).toBe(false);
    expect(workbookUses1904('<?pi <workbookPr date1904="1"/> ?><workbookPr date1904="1"/>')).toBe(true);
    // a second declaration anywhere refuses the file
    expect(workbookUses1904('<a><workbookPr date1904="0"/><b><workbookPr date1904="1"/></b></a>')).toBe(true);
  });

  it.each([
    ['an unterminated comment', '<!-- <workbookPr date1904="0"/>'],
    ['an unterminated CDATA', '<![CDATA[ x'],
    ['an unterminated start tag', '<workbookPr date1904="0"'],
    ['an unterminated attribute value', '<workbookPr date1904="0/>'],
    ['an unquoted value', '<workbookPr date1904=1/>'],
    ['a value-less attribute', '<workbookPr date1904/>'],
    ['a duplicated attribute', '<workbookPr date1904="0" date1904="1"/>'],
    ['a "<" inside a value', '<workbookPr a="<" date1904="0"/>'],
    ['a DOCTYPE', '<!DOCTYPE x [<!ENTITY e "1">]><workbookPr date1904="&e;"/>'],
    ['an unknown entity', '<workbookPr date1904="&e;"/>'],
    ['a bad character reference', '<workbookPr date1904="&#xD800;"/>'],
    ['attributes without a separator', '<workbookPr a="1"date1904="0"/>'],
    ['a malformed empty element', '<workbookPr date1904="0"/ >'],
    ['a malformed element name', '<1workbookPr date1904="0"/>'],
    ['a NUL character', '<workbookPr date1904="0"/>\u0000'],
    ['an oversized part', ' '.repeat(MAX_WORKBOOK_XML + 1)],
  ])('fails closed on %s', (_n, xml) => {
    expect(() => workbookUses1904(xml)).toThrow(XmlFlagsError);
  });

  it('a workbook whose calendar part cannot be parsed is refused with the way out, not read', () => {
    expect(() => readXlsxSheets(wb('<workbookPr date1904=1/>'))).toThrow(
      /date system could not be determined/,
    );
  });
});
