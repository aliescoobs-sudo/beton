/** Minimal OOXML writer: inline text (never formulas), numeric amounts, no macro or external link. */
import { validDate } from './period';
export type Cell = string | number | { date: string } | null;
const xml = (v: string) =>
  v
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
function column(index: number) {
  let r = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) r = String.fromCharCode(65 + ((n - 1) % 26)) + r;
  return r;
}
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>): Buffer {
  const body: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name),
      bytes = Buffer.from(value),
      crc = crc32(bytes);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(bytes.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(filename.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(bytes.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    body.push(h, filename, bytes);
    directory.push(c, filename);
    offset += h.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, central, end]);
}
export function xlsx(sheets: { name: string; rows: Cell[][] }[]): Buffer {
  if (!sheets.length || sheets.some((s) => s.rows.length > 100000)) throw new Error('EXPORT_TOO_LARGE');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const files: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173244"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf fontId="0" fillId="0" borderId="0" numFmtId="0"/><xf fontId="1" fillId="2" borderId="0" numFmtId="0" applyFont="1" applyFill="1"/><xf fontId="0" fillId="0" borderId="0" numFmtId="4" applyNumberFormat="1"/><xf fontId="0" fillId="0" borderId="0" numFmtId="164" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  for (const [i, sheet] of sheets.entries()) {
    const rows = sheet.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((value, c) => {
              const ref = column(c) + (r + 1);
              if (value && typeof value === 'object') {
                if (!validDate(value.date)) throw new Error('INVALID_DATE');
                return `<c r="${ref}" s="3"><v>${(Date.parse(value.date) - Date.parse('1899-12-30')) / 86400000}</v></c>`;
              }
              if (typeof value === 'number') {
                if (!Number.isFinite(value)) throw new Error('INVALID_NUMBER');
                return `<c r="${ref}" s="${r === 0 ? 1 : 2}"><v>${value}</v></c>`;
              }
              return `<c r="${ref}" t="inlineStr" s="${r === 0 ? 1 : 0}"><is><t xml:space="preserve">${xml(value ?? '')}</t></is></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] =
      `<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="20" width="23" customWidth="1"/></cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${column(Math.max(1, ...sheet.rows.map((r) => r.length)) - 1)}${Math.max(1, sheet.rows.length)}"/></worksheet>`;
  }
  return zip(files);
}
