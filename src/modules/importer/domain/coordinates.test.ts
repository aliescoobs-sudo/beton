import { describe, expect, it } from 'vitest';
import { readXlsxSheets } from './sheet';
import { buildXlsx, type PackageEdit } from './xlsx-writer';

// R19-10: a tiny package cannot ask for a huge allocation. Every case is a few hundred bytes of XML; each must be refused quickly and without growing the heap,
// in the plain reader and in the exact-rows mode the history reader uses; the control (a normal file, a wide formatted range) still reads.
const SHEET = 'xl/worksheets/sheet1.xml';
const sheetXml = (inner: string) =>
  `<?xml version="1.0"?><worksheet><sheetData>${inner}</sheetData></worksheet>`;
const withSheet = (xml: string): Buffer =>
  buildXlsx([['a']], {
    inline: true,
    edit: (e) => e.map(([n, c]) => [n, n === SHEET ? xml : c] as [string, string]),
  });
const cell = (ref: string) => `<c r="${ref}" t="inlineStr"><is><t>x</t></is></c>`;

const refused = (xml: string, exactRows: boolean, maxBytes = 2000) => {
  const buf = withSheet(xml);
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  let msg = '';
  try {
    readXlsxSheets(buf, { exactRows });
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(performance.now() - t0, 'bounded time').toBeLessThan(3000);
  expect(process.memoryUsage().heapUsed - heap0, 'bounded memory').toBeLessThan(150 * 1024 * 1024);
  expect(buf.length, 'a small package').toBeLessThan(maxBytes);
  return msg;
};

describe.each([false, true])(
  'R19-10: extreme coordinates are refused before allocation (exactRows=%s)',
  (exact) => {
    it('control: a normal sheet and a wide formatted range read', () => {
      const ok = withSheet(
        sheetXml(`<row r="1">${cell('A1')}${cell('XFD1')}</row><row r="3">${cell('B3')}</row>`),
      );
      expect(readXlsxSheets(ok, { exactRows: exact })[0]?.rows.length).toBeGreaterThanOrEqual(2);
    });
    it.each([
      ['a gigantic row number', sheetXml(`<row r="99999999999">${cell('A99999999999')}</row>`), /row number/],
      ['a row number beyond the limit', sheetXml(`<row r="1000000">${cell('A1000000')}</row>`), /row number/],
      [
        'a row number that is not a safe integer',
        sheetXml(`<row r="${'9'.repeat(40)}">${cell('A1')}</row>`),
        /row number/,
      ],
      [
        'a column reference of many letters',
        sheetXml(`<row r="1">${cell('ZZZZZZZZZZZZZZZZ1')}</row>`),
        /column reference/,
      ],
      ['a column beyond XFD', sheetXml(`<row r="1">${cell('XFE1')}</row>`), /column reference/],
    ])('%s', (_n, xml, re) => {
      expect(refused(xml, exact)).toMatch(re);
    });
    it('many rows each placing a cell at the last column exceed the cumulative padding budget', () => {
      const rows = Array.from(
        { length: 400 },
        (_, i) => `<row r="${i + 1}">${cell(`XFD${i + 1}`)}</row>`,
      ).join('');
      const msg = refused(sheetXml(rows), exact, 60_000);
      expect(msg).toMatch(/too much padding/);
    });
  },
);

describe('R19-10: rows far apart (exact rows) stay inside the row limit', () => {
  it('the highest allowed row is read with bounded memory (its padding is at most the row limit); the plain reader does not pad rows', () => {
    const rows = [1, 199_999].map((r) => `<row r="${r}">${cell(`A${r}`)}</row>`).join('');
    const buf = withSheet(sheetXml(rows));
    const heap0 = process.memoryUsage().heapUsed;
    expect(readXlsxSheets(buf, { exactRows: true })[0]?.rows.length).toBe(199_999);
    expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(150 * 1024 * 1024);
    expect(readXlsxSheets(buf)[0]?.rows.length).toBe(2);
  });
});
void (null as unknown as PackageEdit);
