import { createHash } from 'node:crypto';
import { stableJson } from '../../domain/confirmation';
import { type NamedSheet, readXlsxSheets, SheetError } from '../../domain/sheet';
import { categoryKey, clientKey, driverKey, foldKey, pumpKey, truckKey, typeKey } from '../domain/normalise';
import { type FileFacts, TWIN_MARKER_SHEET, TWIN_MARKER_TEXT } from '../domain/guard';
import { deliveryContamination, expenseContamination, rawContamination } from '../domain/twin-content';
import { columnsOf, type HistoryMapping } from '../domain/mapping';
import {
  type DeliveryRow,
  deliveryKeys,
  type ExpenseRow,
  expenseKeys,
  parseDeliverySheet,
  parseExpenseSheet,
  type Quarantined,
  type SheetStats,
} from '../domain/parse';

// T11: a folder of monthly files for ONE plant and ONE kind, read with ONE mapping. The files are numbered by their position in the sorted folder
// listing ("File 3"); a file name is never read as data (the row date is the truth) and never printed.

export interface InputFile {
  ord: number;
  buf: Buffer;
}
export interface FileReport {
  file: number;
  /** Sheets read, by position; sheets left alone ("ignored"), by position. */
  read: { sheet: number; stats: SheetStats }[];
  ignored: number[];
  /** Fixed phrases: a missing required header, an ambiguous one, an unreadable file, an included sheet with no DATE column. */
  problems: string[];
}
export interface SetRead {
  setSha: string;
  fileShas: string[];
  files: FileReport[];
  deliveries: DeliveryRow[];
  expenses: ExpenseRow[];
  quarantine: (Quarantined & { kind: HistoryMapping['kind'] })[];
  facts: FileFacts[];
  problems: string[];
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sameSheet = (a: string, b: string) => foldKey(a) === foldKey(b);

/** What identifies a decision: the files (their bytes), the kind, the plant and the mapping. */
export function setSha(files: InputFile[], mapping: HistoryMapping): string {
  return sha256(stableJson({ v: 1, kind: mapping.kind, files: files.map((f) => sha256(f.buf)), mapping }));
}

export function readSet(files: InputFile[], mapping: HistoryMapping): SetRead {
  const out: SetRead = {
    setSha: setSha(files, mapping),
    fileShas: files.map((f) => sha256(f.buf)),
    files: [],
    deliveries: [],
    expenses: [],
    quarantine: [],
    facts: [],
    problems: [],
  };
  for (const f of files) {
    const report: FileReport = { file: f.ord, read: [], ignored: [], problems: [] };
    const facts: FileFacts = { marked: false, names: [], expenseLabels: [], contaminated: [] };
    let sheets: NamedSheet[];
    try {
      sheets = readXlsxSheets(f.buf, {
        exactRows: true,
        include: (name) =>
          sameSheet(name, mapping.sheet) ||
          sameSheet(name, TWIN_MARKER_SHEET) ||
          mapping.includeSheets.some((s) => sameSheet(name, s)),
      });
    } catch (e) {
      if (e instanceof SheetError) {
        report.problems.push(`FILE_UNREADABLE: ${e.message}`); // a fixed phrase of the reader, never a cell
        out.files.push(report);
        out.facts.push(facts);
        continue;
      }
      throw e;
    }
    const main = sheets.filter((s) => !s.skipped && sameSheet(s.name, mapping.sheet));
    if (main.length === 0) report.problems.push('SHEET_MISSING: the mapped sheet is not in this file');
    if (main.length > 1) report.problems.push('SHEET_AMBIGUOUS: two sheets have the mapped name');
    for (const [index, sheet] of sheets.entries()) {
      const pos = index + 1;
      if (sheet.skipped) {
        report.ignored.push(pos);
        continue;
      }
      if (sameSheet(sheet.name, TWIN_MARKER_SHEET)) {
        facts.marked = (sheet.rows[0]?.[0] ?? '') === TWIN_MARKER_TEXT;
        report.ignored.push(pos);
        continue;
      }
      const isMain = sameSheet(sheet.name, mapping.sheet);
      if (isMain && main.length > 1) {
        report.ignored.push(pos);
        continue;
      }
      if (!isMain) {
        // an included extra sheet is read only when it has a DATE column (the explicit per-sheet flag, and no guessing)
        const dateNames = (columnsOf(mapping).date ?? []).map(foldKey);
        const header = (sheet.rows[mapping.headerRow - 1] ?? []).map(foldKey);
        if (!header.some((h) => dateNames.includes(h))) {
          report.ignored.push(pos);
          report.problems.push(
            `SHEET_NO_DATE_COLUMN: sheet ${pos} is listed in includeSheets but has no DATE column; ignored`,
          );
          continue;
        }
      }
      const at = { file: f.ord, sheet: pos };
      if (mapping.kind === 'deliveries') {
        const r = parseDeliverySheet(sheet, mapping, at);
        for (const m of r.missing) report.problems.push(`HEADER_MISSING: ${m}`);
        for (const m of r.ambiguous) report.problems.push(`HEADER_AMBIGUOUS: ${m}`);
        out.deliveries.push(...r.rows);
        out.quarantine.push(...r.quarantine.map((q) => ({ ...q, kind: 'deliveries' as const })));
        report.read.push({ sheet: pos, stats: r.stats });
        for (const row of r.rows) facts.contaminated!.push(...deliveryContamination(row));
        for (const q of r.quarantine) facts.contaminated!.push(...rawContamination('deliveries', q.raw));
        for (const row of r.rows)
          facts.names.push(...[row.client, row.driver, row.site].filter((v) => v !== ''));
        for (const q of r.quarantine)
          facts.names.push(
            ...[q.raw.client ?? '', q.raw.driver ?? '', q.raw.site ?? ''].filter((v) => v !== ''),
          );
      } else {
        const r = parseExpenseSheet(sheet, mapping, at);
        for (const m of r.missing) report.problems.push(`HEADER_MISSING: ${m}`);
        for (const m of r.ambiguous) report.problems.push(`HEADER_AMBIGUOUS: ${m}`);
        out.expenses.push(...r.rows);
        out.quarantine.push(...r.quarantine.map((q) => ({ ...q, kind: 'expenses' as const })));
        report.read.push({ sheet: pos, stats: r.stats });
        for (const row of r.rows) facts.contaminated!.push(...expenseContamination(row));
        for (const q of r.quarantine) facts.contaminated!.push(...rawContamination('expenses', q.raw));
        facts.expenseLabels.push(
          ...r.rows.map((x) => x.label),
          ...r.quarantine.map((q) => q.raw.label ?? '').filter((v) => v !== ''),
        );
      }
    }
    out.files.push(report);
    out.facts.push(facts);
  }
  if (files.length === 0) out.problems.push('NO_FILES: the folder holds no .xlsx file');
  return out;
}

/** The distinct label keys the set uses, by kind, with the number of rows and one display label each (first seen). */
export function labelUsage(
  read: SetRead,
): Map<string, { kind: string; key: string; label: string; uses: number }> {
  const usage = new Map<string, { kind: string; key: string; label: string; uses: number }>();
  const add = (kind: string, key: string | null, label: string) => {
    if (!key) return;
    const id = `${kind}\u0000${key}`;
    const cur = usage.get(id);
    if (cur) cur.uses++;
    else usage.set(id, { kind, key, label: label.trim().replace(/\s+/g, ' ').slice(0, 200), uses: 1 });
  };
  for (const r of read.deliveries) {
    const k = deliveryKeys(r);
    add('client', k.client, r.client);
    add('truck', k.truck, r.truck);
    add('driver', k.driver, r.driver);
    add('type', k.type, r.typeRaw);
    add('pump', k.pump, r.pumpRaw);
  }
  for (const r of read.expenses) {
    const k = expenseKeys(r);
    add('category', k.category, r.label.replace(/[0-9]/g, '').trim() || r.label);
    add('truck', k.truck, r.truck);
  }
  // a quarantined row may be fixed later: its labels are staged with the others, so the owner decides them up front
  for (const q of read.quarantine) {
    if (q.kind === 'deliveries') {
      const g = (f: string) => (q.raw[f] ?? '').trim();
      add('client', g('client') ? clientKey(g('client')) : null, g('client'));
      add('truck', g('truck') ? truckKey(g('truck')) : null, g('truck'));
      add('driver', g('driver') ? driverKey(g('driver')) : null, g('driver'));
      add('type', g('type') ? typeKey(g('type')) : null, g('type'));
      add('pump', g('pump') ? pumpKey(g('pump')) : null, g('pump'));
    } else {
      const label = (q.raw.label ?? '').trim();
      add('category', label ? categoryKey(label) || null : null, label.replace(/[0-9]/g, '').trim() || label);
      add('truck', (q.raw.truck ?? '').trim() ? truckKey(q.raw.truck as string) : null, q.raw.truck ?? '');
    }
  }
  return usage;
}
