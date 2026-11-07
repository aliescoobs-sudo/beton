import type { RollbackReport, WorkbookReport } from './workbook-import';

// The text report of a run: the sheet's position ("Sheet 2"), its kind, the row number and a fixed phrase. Never a cell, never a sheet's
// real name, never a name, ICE, phone or amount from the file (R14-09). The in-memory WorkbookReport still carries each row's `label`,
// which IS the file's own text: the object is sensitive and is never printed or stored; only this formatter's output is.

export function formatWorkbookReport(r: WorkbookReport): string {
  const head = r.alreadyImportedRunId
    ? `NOTHING DONE: this exact file was already imported (run ${r.alreadyImportedRunId}).`
    : r.mode === 'dry-run'
      ? 'DRY RUN: validated against the database in a transaction that was rolled back. Nothing was written.'
      : r.applied
        ? `IMPORT DONE in one transaction (run ${r.runId}).`
        : 'IMPORT REFUSED: nothing was written (see the problems below).';
  const lines = [
    head,
    `file sha256 ${r.sha256} (${r.sizeBytes} bytes)`,
    ...r.fileProblems.map((p) => `FILE: ${p}`),
    ...(r.unmappedSheets.length
      ? [`Sheets with no mapping, left alone: ${r.unmappedSheets.join(', ')}`]
      : []),
  ];
  for (const s of r.sheets) {
    const c = s.report.counts;
    lines.push(
      `[${s.sheet}] ${s.kind}: rows ${s.report.rows.length} · new ${c.new + c.created} · already there ${c.exists} · errors ${c.error} · failed ${c.failed}`,
    );
    if (s.formulaCellsRead > 0)
      lines.push(
        `  CACHED FORMULA VALUES USED: ${s.formulaCellsRead} cell(s) were read from the value Excel last stored, not calculated`,
      );
    if (s.report.missingColumns.length)
      lines.push(`  missing columns: ${s.report.missingColumns.join(', ')}`);
    for (const row of s.report.rows)
      if (row.status === 'error' || row.status === 'failed') lines.push(`  row ${row.row}: ${row.message}`);
  }
  const t = r.totals;
  lines.push(
    `TOTAL rows ${t.rows} · new ${t.new + t.created} · already there ${t.exists} · errors ${t.error} · failed ${t.failed}`,
  );
  return lines.join('\n');
}

export function formatRollbackReport(r: RollbackReport): string {
  if (r.alreadyRolledBack) return `NOTHING DONE: run ${r.runId} was already rolled back.`;
  if (r.blocked.length)
    return [`ROLLBACK REFUSED, nothing changed (run ${r.runId}):`, ...r.blocked.map((b) => `  ${b}`)].join(
      '\n',
    );
  const list = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ') || 'none';
  return [
    `ROLLBACK DONE for run ${r.runId} (nothing deleted):`,
    `  archived: ${list(r.archived)}`,
    `  cheques and LCN cancelled: ${r.cancelledInstruments}`,
    `  stays as recorded, by design (correct with a newer version or a reversing entry): ${list(r.staysAsRecorded)}`,
  ].join('\n');
}
