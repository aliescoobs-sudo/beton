import { inflateRawSync } from 'node:zlib';
import { workbookUses1904, XmlFlagsError } from './xml-flags';

// A small, read-only reader for the spreadsheets the office sends (.xlsx) and for CSV. No dependency: an .xlsx is a zip of XML
// files, and only the cells are read (no formula is evaluated, no macro or external link is followed). Limits keep a hostile or
// broken file from using the server's memory.

export type Sheet = string[][];
const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED = 25 * 1024 * 1024;
const MAX_CELLS = 200_000;

export class SheetError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SheetError('not an xlsx file (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || count === 0xffff) throw new SheetError('too many parts in the file');
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new SheetError('damaged zip directory');
    const flags = buf.readUInt16LE(p + 8);
    if (flags & 1) throw new SheetError('an encrypted file cannot be read');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, {
      name,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): string {
  if (e.uncompressedSize > MAX_UNCOMPRESSED) throw new SheetError('a part of the file is too large');
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new SheetError('damaged zip entry');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  const data =
    e.method === 0
      ? raw
      : e.method === 8
        ? inflateRawSync(raw, { maxOutputLength: MAX_UNCOMPRESSED })
        : (() => {
            throw new SheetError('unsupported compression');
          })();
  return data.toString('utf8');
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

const textOf = (xml: string): string =>
  [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1] ?? '')).join('');

const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export interface NamedSheet {
  name: string;
  rows: Sheet;
  /**
   * R14-04: how many cells of the sheet hold a FORMULA. The reader never evaluates one; it can only read the value Excel last stored
   * with it (the "cached" value), which may be stale or wrong. The importer refuses such a sheet unless its mapping says to use the
   * cached values, and then lists the count in the report.
   */
  formulaCells: number;
}

/** The sheet names in workbook order with the part that holds each, from workbook.xml and its relationships. */
function sheetParts(buf: Buffer, zip: Map<string, ZipEntry>): { name: string; part: string }[] {
  const byFile = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const wb = zip.get('xl/workbook.xml');
  const rels = zip.get('xl/_rels/workbook.xml.rels');
  const named: { name: string; part: string }[] = [];
  if (wb && rels) {
    const targets = new Map<string, string>();
    for (const m of readEntry(buf, rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const id = /\bId="([^"]*)"/.exec(m[1] ?? '')?.[1];
      const target = /\bTarget="([^"]*)"/.exec(m[1] ?? '')?.[1];
      if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
    for (const m of readEntry(buf, wb).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
      const attrs = m[1] ?? '';
      const name = decode(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
      const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1];
      const part = rid ? targets.get(rid) : undefined;
      if (name && part && zip.has(part)) named.push({ name, part });
    }
  }
  // A workbook without usable names (a writer that leaves them out) is read in file order as Sheet1, Sheet2...
  return named.length ? named : byFile.map((part, i) => ({ name: `Sheet${i + 1}`, part }));
}

/** Every sheet of a workbook with its name, in workbook order. Empty cells are ''. A date cell comes as its serial number. */
export function readXlsxSheets(buf: Buffer): NamedSheet[] {
  const zip = zipEntries(buf);
  // R14-04: the workbook's date system. A date cell is a number of days from an origin that depends on it (1899-12-30, or 1904-01-01,
  // 1462 days later). This reader only knows the first, so a 1904 workbook is refused, never read with the wrong origin.
  const wbXml = zip.get('xl/workbook.xml') ? readEntry(buf, zip.get('xl/workbook.xml') as ZipEntry) : '';
  // R17-05: read by a bounded XML tokenizer (not a regular expression over the text), failing closed on anything it cannot parse.
  try {
    if (workbookUses1904(wbXml))
      throw new SheetError(
        'this workbook uses the 1904 date system, which is not supported: in Excel, untick "Use 1904 date system" (File > Options > Advanced) and save it again',
      );
  } catch (e) {
    if (e instanceof XmlFlagsError) throw new SheetError(e.message);
    throw e;
  }
  const shared = zip.get('xl/sharedStrings.xml');
  const strings = shared
    ? [...readEntry(buf, shared).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] ?? ''))
    : [];
  let cells = 0;
  return sheetParts(buf, zip).map(({ name, part }) => {
    const xml = readEntry(buf, zip.get(part) as ZipEntry);
    const rows: Sheet = [];
    let formulaCells = 0;
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const line: string[] = [];
      for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cells > MAX_CELLS) throw new SheetError('too many cells');
        const attrs = c[1] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const body = c[2] ?? '';
        if (/<f\b/.test(body)) formulaCells++;
        let value = '';
        if (type === 's') value = strings[Number(/<v>(\d+)<\/v>/.exec(body)?.[1])] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else value = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        const i = ref ? colIndex(ref) : line.length;
        while (line.length < i) line.push('');
        line[i] = value.trim();
      }
      rows.push(line);
    }
    while (rows.length && rows[rows.length - 1]!.every((v) => v === '')) rows.pop();
    return { name, rows, formulaCells };
  });
}

/** The cells of one sheet (the first by default) as rows of text. */
export function readXlsx(buf: Buffer, sheetIndex = 0): Sheet {
  const sheet = readXlsxSheets(buf)[sheetIndex];
  if (!sheet) throw new SheetError('the workbook has no such sheet');
  return sheet.rows;
}

/** CSV with a comma or semicolon (the office's Excel exports semicolons), quotes and a BOM. */
export function readCsv(text: string): Sheet {
  const src = text.replace(/^﻿/, '');
  const delim =
    (src.split('\n', 1)[0] ?? '').split(';').length > (src.split('\n', 1)[0] ?? '').split(',').length
      ? ';'
      : ',';
  const rows: Sheet = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  // R14-04: an opening quote that is never closed swallows the rest of the file into one cell; that is a damaged file, not a value.
  if (quoted) throw new SheetError('the CSV file has a quote that is never closed');
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1]!.every((v) => v === '')) rows.pop();
  if (rows.length > MAX_CELLS) throw new SheetError('too many rows');
  return rows;
}

/** A file as named sheets: every sheet of an .xlsx, or one sheet called "csv" for a CSV file. */
export function readWorkbook(buf: Buffer): NamedSheet[] {
  return buf.subarray(0, 2).toString('latin1') === 'PK'
    ? readXlsxSheets(buf)
    : [{ name: 'csv', rows: readCsv(buf.toString('utf8')), formulaCells: 0 }];
}

/** The rows of a file by its first bytes ("PK" is a zip, so an .xlsx), not by its name. */
export function readSheet(buf: Buffer): Sheet {
  return buf.subarray(0, 2).toString('latin1') === 'PK' ? readXlsx(buf) : readCsv(buf.toString('utf8'));
}

export type DateFormat = 'dmy' | 'mdy' | 'iso';

const validYmd = (y: number, m: number, d: number): string | null => {
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > last ? null : `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * A date as YYYY-MM-DD, or null when it is not one. Strict: an ISO date, a text date with a four-digit year in the order the mapping
 * declares ('dmy' by default, 'mdy', or 'iso' to refuse every text but ISO), or an Excel serial of 2000 to 2099. A day or a month that
 * does not exist (31/02, 13/13), a two-digit year, mixed separators and a text in the other order are refused, never reinterpreted.
 */
export function toIsoDate(value: string, format: DateFormat = 'dmy'): string | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (format === 'iso') return null;
  const text = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(v);
  if (text) {
    const [a, b, y] = [Number(text[1]), Number(text[3]), Number(text[4])];
    return format === 'dmy' ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const serial = Math.floor(Number(v));
    if (serial < 36526 || serial > 73050) return null; // 2000-01-01 to 2099-12-31
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();

/** Header row to records: `columns` maps our field to the header names accepted for it (accents and case ignored). */
export function toRecords(
  sheet: Sheet,
  columns: Record<string, readonly string[]>,
  /** 1-based row that holds the headers (default 1); the rows above it (a title, a date) are ignored. */
  headerRow = 1,
): {
  records: { row: number; values: Record<string, string> }[];
  missing: string[];
  /** Fields for which TWO columns carry an accepted header (R14-04): which one is meant is not guessed, the sheet is refused. */
  ambiguous: string[];
} {
  const header = (sheet[headerRow - 1] ?? []).map(fold);
  const index: Record<string, number> = {};
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const [field, names] of Object.entries(columns)) {
    const accepted = names.map(fold);
    const hits = header.flatMap((h, k) => (accepted.includes(h) ? [k] : []));
    if (hits.length === 0) missing.push(field);
    else if (hits.length > 1) ambiguous.push(field);
    else index[field] = hits[0] as number;
  }
  const records = sheet.slice(headerRow).flatMap((cells, k) => {
    if (cells.every((c) => c === '')) return [];
    const values: Record<string, string> = {};
    for (const [field, i] of Object.entries(index)) values[field] = (cells[i] ?? '').trim();
    return [{ row: headerRow + k + 1, values }];
  });
  return { records, missing, ambiguous };
}
