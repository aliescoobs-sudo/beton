import { deflateRawSync } from 'node:zlib';

/** A minimal .xlsx for tests: one sheet, shared strings or inline strings, numbers as numbers. Stored or deflated zip entries. */
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

/** R18-09 tests: rewrite the package's entries (name, content) before it is zipped — relocate, drop, empty, corrupt or repeat a part. */
export type PackageEdit = (entries: [string, string][]) => [string, string][];

export function buildXlsx(
  rows: (string | number)[][],
  opts: { deflate?: boolean; inline?: boolean; edit?: PackageEdit } = {},
): Buffer {
  const strings: string[] = [];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${col(ci)}${ri + 1}`;
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            if (opts.inline) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
            strings.push(v);
            return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': PACKAGE_RELS,
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    ...(opts.inline
      ? {}
      : {
          'xl/sharedStrings.xml': `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
        }),
  };
  return zipFiles(files, opts.deflate, opts.edit);
}

/** Test support (R18-09): the same package with its parts rewritten (relocate, drop, empty, corrupt or repeat a part). */
export function rewritePackage(parts: [string, string][], edit: PackageEdit, deflate = false): Buffer {
  return zipFiles(Object.fromEntries(parts), deflate, edit);
}

function zipFiles(files: Record<string, string>, deflate: boolean | undefined, edit?: PackageEdit): Buffer {
  const list = edit ? edit(Object.entries(files)) : Object.entries(files);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of list) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Spreadsheet column letters: 0 = A, 25 = Z, 26 = AA ... */
const colName = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : `${colName(Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`;

/**
 * A synthetic workbook with several named sheets (inline strings, numbers as numbers), for the importer tests and the fixtures.
 * Nothing in it comes from a real file.
 */
export function buildWorkbook(
  sheets: {
    name: string;
    rows: (string | number | { f: string; v: string | number })[][];
    /** T11: format this many columns on every row, as a converted spreadsheet does (empty styled cells, no data). */
    formattedColumns?: number;
    /** T11: the raw `ref` of an `<autoFilter>` element (a converted file may carry one a strict parser rejects). */
    autoFilterRef?: string;
  }[],
  deflate = false,
  /** `date1904`: write the 1904 date system into the workbook (a fixture for the refusal). */
  opts: {
    date1904?: boolean;
    /** R18-09 tests: edit the package's parts before zipping. */
    edit?: PackageEdit;
    /** The raw `workbookPr` element, to write other XML spellings of the same flag. */ workbookPr?: string;
  } = {},
): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': PACKAGE_RELS,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="r">${opts.workbookPr ?? (opts.date1904 ? '<workbookPr date1904="1"/>' : '')}<sheets>${sheets
      .map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships>${sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  };
  sheets.forEach((s, si) => {
    const rows = s.rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) => {
              const ref = `${colName(ci)}${ri + 1}`;
              if (typeof v === 'object')
                return typeof v.v === 'number'
                  ? `<c r="${ref}"><f>${escXml(v.f)}</f><v>${v.v}</v></c>`
                  : `<c r="${ref}" t="str"><f>${escXml(v.f)}</f><v>${escXml(v.v)}</v></c>`;
              return typeof v === 'number'
                ? `<c r="${ref}"><v>${v}</v></c>`
                : `<c r="${ref}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
            })
            .join(
              '',
            )}${Array.from({ length: Math.max(0, (s.formattedColumns ?? 0) - r.length) }, (_, k) => `<c r="${colName(r.length + k)}${ri + 1}" s="1"/>`).join('')}</row>`,
      )
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] =
      `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData>${s.autoFilterRef ? `<autoFilter ref="${escXml(s.autoFilterRef)}"/>` : ''}</worksheet>`;
  });
  return zipFiles(files, deflate, opts.edit);
}
