import { inflateRawSync } from 'node:zlib';

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

/** The cells of one sheet (the first by default) as rows of text. Empty cells are ''. A date cell comes as its serial number. */
export function readXlsx(buf: Buffer, sheetIndex = 0): Sheet {
  const zip = zipEntries(buf);
  const shared = zip.get('xl/sharedStrings.xml');
  const strings = shared
    ? [...readEntry(buf, shared).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] ?? ''))
    : [];
  const sheets = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const name = sheets[sheetIndex];
  if (!name) throw new SheetError('the workbook has no such sheet');
  const xml = readEntry(buf, zip.get(name) as ZipEntry);
  const rows: Sheet = [];
  let cells = 0;
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const line: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (++cells > MAX_CELLS) throw new SheetError('too many cells');
      const attrs = c[1] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const body = c[2] ?? '';
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
  return rows;
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
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1]!.every((v) => v === '')) rows.pop();
  if (rows.length > MAX_CELLS) throw new SheetError('too many rows');
  return rows;
}

/** The rows of a file by its first bytes ("PK" is a zip, so an .xlsx), not by its name. */
export function readSheet(buf: Buffer): Sheet {
  return buf.subarray(0, 2).toString('latin1') === 'PK' ? readXlsx(buf) : readCsv(buf.toString('utf8'));
}

/** An Excel date serial (days since 1899-12-30) or an ISO / dd/mm/yyyy text as YYYY-MM-DD; null when it is none of them. */
export function toIsoDate(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (/^\d{4,6}(\.\d+)?$/.test(v)) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
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
): { records: { row: number; values: Record<string, string> }[]; missing: string[] } {
  const header = (sheet[0] ?? []).map(fold);
  const index: Record<string, number> = {};
  const missing: string[] = [];
  for (const [field, names] of Object.entries(columns)) {
    const i = header.findIndex((h) => names.map(fold).includes(h));
    if (i < 0) missing.push(field);
    else index[field] = i;
  }
  const records = sheet.slice(1).flatMap((cells, k) => {
    if (cells.every((c) => c === '')) return [];
    const values: Record<string, string> = {};
    for (const [field, i] of Object.entries(index)) values[field] = (cells[i] ?? '').trim();
    return [{ row: k + 2, values }];
  });
  return { records, missing };
}
