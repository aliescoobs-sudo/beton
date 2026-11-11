import { parseImportAmount } from '../../domain/values';
import { type NamedSheet, toIsoDate } from '../../domain/sheet';
import {
  blNumber,
  blSuspect,
  categoryKey,
  clientKey,
  driverKey,
  foldKey,
  litresInText,
  parseVolumeM3,
  pumpKey,
  taxBasisOfRow,
  truckKey,
  typeKey,
} from './normalise';
import { columnsOf, type HistoryMapping, REQUIRED_FIELDS } from './mapping';

// T11: one sheet of a monthly file to history rows. Deterministic code only. The sheet is read by HEADER NAME; a row that cannot be read
// is QUARANTINED with a fixed reason (never imported silently, never guessed); a totals row (a formula) and a blank row are skipped and
// counted. Nothing here carries a cell into a message: reports are built from counts and row numbers.

export interface Source {
  file: number;
  sheet: number;
  row: number;
}
export type QuarantineReason =
  'NO_DATE' | 'BAD_DATE' | 'NO_VOLUME' | 'BAD_VOLUME' | 'NO_AMOUNT' | 'BAD_AMOUNT' | 'NO_LABEL';
export interface Quarantined {
  src: Source;
  reason: QuarantineReason;
  /** The cells as the sheet has them, by field name: the owner reads them on the staging screen (owner/app_admin only). */
  raw: Record<string, string>;
}

export interface DeliveryRow {
  src: Source;
  date: string;
  volumeL: number;
  client: string;
  site: string;
  typeRaw: string;
  pumpRaw: string;
  truck: string;
  driver: string;
  bl: string;
  blSuspect: boolean;
  taxBasis: 'HT' | 'TTC' | null;
  note: string;
  legacy: Record<string, string>;
}
export interface ExpenseRow {
  src: Source;
  date: string | null;
  month: string;
  label: string;
  quantityMl: number | null;
  amountCentimes: number;
  truck: string;
  legacy: Record<string, string>;
}

/** Per month, numbers only: rows and litres read (quarantined ones included), rows and litres quarantined; centimes read (expenses). */
export interface MonthStats {
  rows: number;
  litres: number;
  qRows: number;
  qLitres: number;
  cents: number;
}
export interface SheetStats {
  /** Data rows seen (not the header, not a blank, not a totals formula). */
  rowsRead: number;
  imported: number;
  quarantined: number;
  blankSkipped: number;
  formulaRowsSkipped: number;
  /** Headers that are neither mapped nor kept as legacy (by position, never their text). */
  unmappedColumns: number;
  /** Rows (sheet row numbers) whose delivery note value is shared with another row, capped; and the number of missing numbers in the run. */
  blDuplicateRows: number[];
  blGaps: number;
  blSuspectRows: number[];
  /** Per month: rows and litres read (quarantined ones included), rows and litres quarantined. */
  months: Record<string, MonthStats>;
}
export interface SheetResult<R> {
  rows: R[];
  quarantine: Quarantined[];
  stats: SheetStats;
  /** Required fields with no header (the sheet cannot be read), by field name. */
  missing: string[];
  /** Fields with two accepted headers (which one is meant is not guessed). */
  ambiguous: string[];
}
const CAP = 200;

const emptyStats = (): SheetStats => ({
  rowsRead: 0,
  imported: 0,
  quarantined: 0,
  blankSkipped: 0,
  formulaRowsSkipped: 0,
  unmappedColumns: 0,
  blDuplicateRows: [],
  blGaps: 0,
  blSuspectRows: [],
  months: {},
});

interface Layout {
  index: Record<string, number>;
  legacy: [string, number][];
  missing: string[];
  ambiguous: string[];
  unmapped: number;
}

/** Which column is which, by header name. A header-less column takes `blankHeaderField` when exactly one holds data. */
function layoutOf(sheet: NamedSheet, m: HistoryMapping): Layout {
  const header = (sheet.rows[m.headerRow - 1] ?? []).map((h) => foldKey(h));
  const index: Record<string, number> = {};
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const used = new Set<number>();
  for (const [field, names] of Object.entries(columnsOf(m))) {
    const accepted = names.map(foldKey);
    const hits = header.flatMap((h, k) => (h !== '' && accepted.includes(h) ? [k] : []));
    if (hits.length === 1) {
      index[field] = hits[0] as number;
      used.add(hits[0] as number);
    } else if (hits.length > 1) ambiguous.push(field);
    else if (REQUIRED_FIELDS[m.kind].includes(field)) missing.push(field);
  }
  if (m.blankHeaderField && index[m.blankHeaderField] === undefined) {
    const withData = header.flatMap((h, k) =>
      h === '' && sheet.rows.slice(m.headerRow).some((r) => (r[k] ?? '') !== '') ? [k] : [],
    );
    if (withData.length === 1) {
      index[m.blankHeaderField] = withData[0] as number;
      used.add(withData[0] as number);
      const at = missing.indexOf(m.blankHeaderField);
      if (at >= 0) missing.splice(at, 1);
    }
  }
  const legacy: [string, number][] = [];
  for (const name of m.legacyColumns) {
    const k = header.indexOf(foldKey(name));
    if (k >= 0 && !used.has(k)) {
      legacy.push([foldKey(name).toLowerCase().replace(/ /g, '_'), k]);
      used.add(k);
    }
  }
  const unmapped = header.filter((h, k) => h !== '' && !used.has(k)).length;
  return { index, legacy, missing, ambiguous, unmapped };
}

const cell = (row: string[], k: number | undefined): string => (k === undefined ? '' : (row[k] ?? '').trim());
const numeric = (v: string) => /^\d+([.,]\d+)?$/.test(v.replace(/[\s  ]/g, ''));

function walk<R>(
  sheet: NamedSheet,
  m: HistoryMapping,
  src: { file: number; sheet: number },
  stats: SheetStats,
  one: (
    row: string[],
    at: Source,
    layout: Layout,
    hasFormula: boolean,
  ) => { row?: R; quarantine?: Quarantined; blank?: boolean; formula?: boolean },
): SheetResult<R> & { layout: Layout } {
  const layout = layoutOf(sheet, m);
  stats.unmappedColumns = layout.unmapped;
  const out: SheetResult<R> = {
    rows: [],
    quarantine: [],
    stats,
    missing: layout.missing,
    ambiguous: layout.ambiguous,
  };
  if (layout.missing.length || layout.ambiguous.length) return { ...out, layout };
  const formula = new Set(sheet.formulaRows ?? []);
  for (let r = m.headerRow; r < sheet.rows.length; r++) {
    const rowNo = r + 1;
    const verdict = one(sheet.rows[r] ?? [], { ...src, row: rowNo }, layout, formula.has(rowNo));
    if (verdict.formula) stats.formulaRowsSkipped++;
    else if (verdict.blank) stats.blankSkipped++;
    else {
      stats.rowsRead++;
      if (verdict.row) {
        out.rows.push(verdict.row);
        stats.imported++;
      } else if (verdict.quarantine) {
        out.quarantine.push(verdict.quarantine);
        stats.quarantined++;
      }
    }
  }
  return { ...out, layout };
}

const bump = (stats: SheetStats, month: string, litres: number, quarantined: boolean, cents = 0) => {
  const slot = (stats.months[month] ??= { rows: 0, litres: 0, qRows: 0, qLitres: 0, cents: 0 });
  slot.rows++;
  slot.litres += litres;
  slot.cents += cents;
  if (quarantined) {
    slot.qRows++;
    slot.qLitres += litres;
  }
};

const LEGACY_PREFIX = 'legacy:';

/** A delivery row from its raw cells (by field name). Used for the first read and again for a quarantined row the owner fixed. */
export function deliveryFromRaw(
  raw: Record<string, string>,
  src: Source,
  dateFormat: HistoryMapping['dateFormat'],
): { row: DeliveryRow } | { reason: QuarantineReason; month: string; litres: number } {
  const g = (f: string) => (raw[f] ?? '').trim();
  const vol = parseVolumeM3(g('m3'));
  const iso = g('date') === '' ? null : toIsoDate(g('date'), dateFormat);
  const month = iso?.slice(0, 7) ?? '0000-00';
  const litres = vol.ok ? vol.litres : 0;
  if (g('date') === '') return { reason: 'NO_DATE', month, litres };
  if (!iso) return { reason: 'BAD_DATE', month, litres };
  if (!vol.ok) return { reason: vol.reason, month, litres };
  const legacy: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw))
    if (k.startsWith(LEGACY_PREFIX) && v.trim() !== '') legacy[k.slice(LEGACY_PREFIX.length)] = v.trim();
  if (g('adjuvant') !== '') legacy.adjuvant = g('adjuvant');
  const bl = g('bl');
  return {
    row: {
      src,
      date: iso,
      volumeL: vol.litres,
      client: g('client'),
      site: g('site'),
      typeRaw: g('type'),
      pumpRaw: g('pump'),
      truck: g('truck'),
      driver: g('driver'),
      bl,
      blSuspect: bl !== '' && blSuspect(bl),
      taxBasis: taxBasisOfRow(g('taxbasis'), g('adjuvant')),
      note: g('observations'),
      legacy,
    },
  };
}

/** An expense row from its raw cells. `fallbackMonth` is the mapping's month for a file with no date column. */
export function expenseFromRaw(
  raw: Record<string, string>,
  src: Source,
  dateFormat: HistoryMapping['dateFormat'],
  fallbackMonth: string | null,
): { row: ExpenseRow } | { reason: QuarantineReason; month: string; litres: number } {
  const g = (f: string) => (raw[f] ?? '').trim();
  const iso = g('date') === '' ? null : toIsoDate(g('date'), dateFormat);
  const month = iso?.slice(0, 7) ?? fallbackMonth ?? '0000-00';
  if (g('date') !== '' && !iso) return { reason: 'BAD_DATE', month, litres: 0 };
  if (!iso && !fallbackMonth) return { reason: 'NO_DATE', month, litres: 0 };
  if (g('label') === '') return { reason: 'NO_LABEL', month, litres: 0 };
  if (g('amount') === '') return { reason: 'NO_AMOUNT', month, litres: 0 };
  const cents = parseImportAmount(g('amount'));
  if (!cents.ok) return { reason: 'BAD_AMOUNT', month, litres: 0 };
  return {
    row: {
      src,
      date: iso,
      month,
      label: g('label'),
      quantityMl: litresInText(g('label')),
      amountCentimes: Number(cents.value),
      truck: g('truck'),
      legacy: {},
    },
  };
}

const rawOf = (row: string[], layout: Layout, fields: readonly string[]): Record<string, string> => {
  const raw: Record<string, string> = {};
  for (const f of fields) raw[f] = cell(row, layout.index[f]);
  for (const [name, k] of layout.legacy) raw[`${LEGACY_PREFIX}${name}`] = cell(row, k);
  return raw;
};
const DELIVERY_RAW = [
  'date',
  'client',
  'site',
  'm3',
  'type',
  'pump',
  'truck',
  'driver',
  'bl',
  'observations',
  'taxbasis',
  'adjuvant',
];

/** Delivery sheet (LIVRAISON): row 1 totals, row 2 headers, data from row 3, by default. */
export function parseDeliverySheet(
  sheet: NamedSheet,
  m: HistoryMapping,
  at: { file: number; sheet: number },
): SheetResult<DeliveryRow> {
  const stats = emptyStats();
  const res = walk<DeliveryRow>(sheet, m, at, stats, (row, src, layout, hasFormula) => {
    const raw = rawOf(row, layout, DELIVERY_RAW);
    // a totals row (a formula, no client) is ignored; a row with no client and no numeric m3 is a blank or a stray note: skipped, counted
    if (raw.client === '' && hasFormula) return { formula: true };
    if (raw.client === '' && !numeric(raw.m3 ?? '')) return { blank: true };
    const built = deliveryFromRaw(raw, src, m.dateFormat);
    if ('row' in built) {
      bump(stats, built.row.date.slice(0, 7), built.row.volumeL, false);
      return { row: built.row };
    }
    bump(stats, built.month, built.litres, true);
    return { quarantine: { src, reason: built.reason, raw } };
  });
  // delivery note book: duplicates and gaps are REPORTED (counts and row numbers), never rejected or corrected
  const seen = new Map<number, number[]>();
  for (const r of res.rows) {
    const n = r.bl === '' ? null : blNumber(r.bl);
    if (n === null) continue;
    if (r.blSuspect) {
      if (stats.blSuspectRows.length < CAP) stats.blSuspectRows.push(r.src.row);
      continue;
    }
    seen.set(n, [...(seen.get(n) ?? []), r.src.row]);
  }
  for (const rows of seen.values())
    if (rows.length > 1)
      for (const row of rows) if (stats.blDuplicateRows.length < CAP) stats.blDuplicateRows.push(row);
  const sorted = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++)
    stats.blGaps += (sorted[i] as number) - (sorted[i - 1] as number) - 1;
  return res;
}

/** The label-map keys a delivery row uses, by kind (what staging decides on). */
export const deliveryKeys = (r: DeliveryRow) => ({
  client: r.client === '' ? null : clientKey(r.client),
  truck: r.truck === '' ? null : truckKey(r.truck),
  driver: r.driver === '' ? null : driverKey(r.driver),
  type: r.typeRaw === '' ? null : typeKey(r.typeRaw),
  pump: r.pumpRaw === '' ? null : pumpKey(r.pumpRaw),
});
export const expenseKeys = (r: ExpenseRow) => ({
  category: categoryKey(r.label) || null,
  truck: r.truck === '' ? null : truckKey(r.truck),
});

/** Expense journal (Feuil1, or a sheet named in includeSheets that has a DATE column). */
export function parseExpenseSheet(
  sheet: NamedSheet,
  m: HistoryMapping,
  at: { file: number; sheet: number },
): SheetResult<ExpenseRow> {
  const stats = emptyStats();
  return walk<ExpenseRow>(sheet, m, at, stats, (row, src, layout, hasFormula) => {
    const raw = rawOf(row, layout, ['date', 'label', 'amount', 'truck']);
    if (raw.label === '' && hasFormula) return { formula: true };
    if (raw.label === '' && raw.amount === '') return { blank: true };
    const built = expenseFromRaw(raw, src, m.dateFormat, m.fileMonths[String(src.file)] ?? null);
    if ('row' in built) {
      bump(stats, built.row.month, 0, false, built.row.amountCentimes);
      return { row: built.row };
    }
    bump(stats, built.month, 0, true);
    return { quarantine: { src, reason: built.reason, raw } };
  });
}
