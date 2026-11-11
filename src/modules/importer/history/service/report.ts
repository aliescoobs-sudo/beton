import type { HistoryReport, HistoryRollbackReport } from './history-import';

// The report of a history run: fixed phrases, counts and row numbers. Never a cell, a name, a sheet title or a file name: a file is "File 3",
// a sheet is "sheet 1" (its position). Litres are printed as m³ with three decimals (integer arithmetic only).
const mad = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const m3 = (litres: number) => `${Math.floor(litres / 1000)}.${String(litres % 1000).padStart(3, '0')}`;

export function formatHistoryReport(r: HistoryReport): string {
  const out: string[] = [];
  out.push(`History import (${r.mode}) of ${r.kind}: set ${r.setSha}`);
  out.push(`Typed phrase for apply: HISTORY ${r.setSha}`);
  for (const p of r.problems) out.push(`PROBLEM ${p}`);
  for (const f of r.files) {
    out.push(
      `File ${f.file}: ${f.read.length} sheet(s) read, ${f.ignored.length} ignored${f.ignored.length ? ` (positions ${f.ignored.join(', ')})` : ''}`,
    );
    for (const { sheet, stats: s } of f.read) {
      out.push(
        `  sheet ${sheet}: ${s.rowsRead} rows read, ${s.imported} readable, ${s.quarantined} quarantined, ${s.blankSkipped} blank skipped, ${s.formulaRowsSkipped} totals row(s) ignored, ${s.unmappedColumns} unmapped column(s)`,
      );
      if (s.blDuplicateRows.length)
        out.push(`  sheet ${sheet}: delivery note value shared by rows ${s.blDuplicateRows.join(', ')}`);
      if (s.blGaps) out.push(`  sheet ${sheet}: ${s.blGaps} number(s) missing in the delivery note run`);
      if (s.blSuspectRows.length)
        out.push(`  sheet ${sheet}: suspect delivery note value on rows ${s.blSuspectRows.join(', ')}`);
    }
  }
  const t = r.totals;
  out.push(
    `Totals: ${t.rowsRead} read, ${t.imported} readable, ${t.quarantined} quarantined, ${t.blank} blank, ${t.formulaRows} totals row(s) ignored`,
  );
  out.push(
    r.kind === 'deliveries'
      ? 'Month         rows   m3 read   quarantined rows   quarantined m3'
      : 'Month         rows   MAD read   quarantined rows',
  );
  for (const [month, v] of Object.entries(r.months).sort())
    out.push(
      r.kind === 'deliveries'
        ? `${month.padEnd(10)} ${String(v.rows).padStart(6)} ${m3(v.litres).padStart(10)} ${String(v.qRows).padStart(18)} ${m3(v.qLitres).padStart(16)}`
        : `${month.padEnd(10)} ${String(v.rows).padStart(6)} ${mad(v.cents).padStart(10)} ${String(v.qRows).padStart(18)}`,
    );
  const open = Object.entries(r.openLabels);
  out.push(
    open.length ? `Open mappings: ${open.map(([k, n]) => `${k} ${n}`).join(', ')}` : 'Open mappings: none',
  );
  out.push(`Open quarantined rows: ${r.openQuarantine}`);
  out.push(
    `Delivery note book: ${r.blDuplicateRows} row(s) share a value, ${r.blGaps} missing, ${r.blSuspectRows} suspect (reported, never changed)`,
  );
  for (const b of r.blocked) out.push(`BLOCKED ${b}`);
  if (r.alreadyAppliedBatchId)
    out.push(`Already applied: batch ${r.alreadyAppliedBatchId} (nothing was done)`);
  if (r.staged)
    out.push(
      `Staged: batch ${r.batchId}. Decide the open mappings and quarantined rows on the History screens, then apply.`,
    );
  if (r.applied)
    out.push(
      `Applied: batch ${r.batchId} (${r.created.deliveries} deliveries, ${r.created.expenses} expenses, ${r.created.clients} client(s) created)`,
    );
  return out.join('\n');
}

export function formatHistoryRollback(r: HistoryRollbackReport): string {
  return [
    `History rollback of batch ${r.batchId}`,
    r.alreadyRolledBack
      ? 'Already rolled back: nothing was done.'
      : `Archived clients created by the batch: ${r.archivedClients}`,
    ...r.blocked.map((b) => `BLOCKED ${b}`),
    'The rows stay (no report reads them); staging decisions are kept. Nothing was deleted.',
  ].join('\n');
}
