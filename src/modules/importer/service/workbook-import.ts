import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { cancelInstrument } from '@/modules/ledger';
import { recordAuditEvent, type SessionUser } from '@/modules/platform-security';
import { APPLY_ORDER, mappingForSheet, type MappingKind, type SheetMapping } from '../domain/mapping';
import { type ImportEnvironment, importEnvironmentProblem } from '../domain/guard';
import { type NamedSheet, readWorkbook, SheetError } from '../domain/sheet';
import { defaultColumnsOf, type ImportKind, type ImportReport, runImport } from './importers';
import { RUN_TAG_PREFIX, singleTransactionPool } from './tx-pool';
import { abandon, commitAndRelease, rollbackAndRelease } from './tx-end';

// One workbook, one transaction (T2). The dry run and the real run do exactly the same work, in the same order, through the same
// services as the screens (same rules, row-level security and audit); the dry run ends in a ROLLBACK, so a sheet that refers to a
// type or a client created by an earlier sheet of the same file is validated for real, and nothing stays. The real run commits only
// when no sheet has a problem, so a file is applied whole or not at all.

export class ImportRefused extends Error {
  readonly code: 'ENVIRONMENT' | 'ROLE' | 'STEP_UP_REQUIRED';
  constructor(code: ImportRefused['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface SheetReport {
  sheet: string;
  kind: MappingKind;
  report: ImportReport;
  /** R14-04: formula cells whose last stored (cached) value was read because the mapping allows it. 0 for a sheet with none. */
  formulaCellsRead: number;
}
export interface WorkbookReport {
  sha256: string;
  sizeBytes: number;
  mode: 'dry-run' | 'apply';
  /** True only when the real run committed. A dry run never is. */
  applied: boolean;
  /** The same bytes were already imported by an earlier run that was not rolled back: nothing was done. */
  alreadyImportedRunId: string | null;
  runId: string | null;
  sheets: SheetReport[];
  /** Sheets of the workbook that no mapping names: left alone, listed so a forgotten sheet is seen. */
  unmappedSheets: string[];
  /** Problems with the file or its mappings as a whole (unreadable file, a mapped sheet that is not there, two mappings for a sheet). */
  fileProblems: string[];
  totals: { rows: number; new: number; exists: number; error: number; created: number; failed: number };
}

export interface WorkbookOptions {
  appPool: pg.Pool;
  actor: SessionUser;
  file: Buffer;
  mappings: readonly SheetMapping[];
  mode: 'dry-run' | 'apply';
  environment: ImportEnvironment;
  /**
   * Mapping files the person wrote name sheets that must be there (default true). The built-in defaults cover every kind, so a workbook
   * that carries only some of them is fine: pass false for those.
   */
  requireEveryMappedSheet?: boolean;
  /** The opening date of the books, when the workbook has an opening-balances sheet and none is entered yet. */
  openingDate?: string;
  /** The business date cheques are received on (default: today). */
  today?: string;
}

const IMPORT_ROLES: readonly string[] = ['owner', 'app_admin'];
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** The rule of the environment, asked of the database too: the training marker is a database fact, not a flag. */
export async function assertImportEnvironment(appPool: pg.Pool, env: ImportEnvironment): Promise<void> {
  const seeded =
    (await appPool.query<{ s: boolean }>('select public.training_seeded() as s')).rows[0]?.s === true;
  const problem = importEnvironmentProblem(env, seeded);
  if (problem) throw new ImportRefused('ENVIRONMENT', problem);
}

export function assertActor(actor: SessionUser, mode: 'dry-run' | 'apply') {
  if (!IMPORT_ROLES.includes(actor.role))
    throw new ImportRefused('ROLE', 'Only the owner or an app_admin account may run the import.');
  if (mode === 'apply' && actor.stepUpVerified !== true)
    throw new ImportRefused('STEP_UP_REQUIRED', 'Applying an import needs a fresh second factor (step-up).');
}

const emptyTotals = (): WorkbookReport['totals'] => ({
  rows: 0,
  new: 0,
  exists: 0,
  error: 0,
  created: 0,
  failed: 0,
});

/** Validates a workbook and, in `apply` mode, writes it in one audited transaction. */
export async function importWorkbook(opts: WorkbookOptions): Promise<WorkbookReport> {
  assertActor(opts.actor, opts.mode);
  await assertImportEnvironment(opts.appPool, opts.environment);
  const hash = sha256(opts.file);
  const report: WorkbookReport = {
    sha256: hash,
    sizeBytes: opts.file.length,
    mode: opts.mode,
    applied: false,
    alreadyImportedRunId: null,
    runId: null,
    sheets: [],
    unmappedSheets: [],
    fileProblems: [],
    totals: emptyTotals(),
  };

  let sheets: NamedSheet[];
  try {
    sheets = readWorkbook(opts.file);
  } catch (error) {
    if (error instanceof SheetError) {
      report.fileProblems.push(`The file cannot be read: ${error.message}`);
      return report;
    }
    throw error;
  }

  // which sheet goes with which mapping (a mapped sheet missing from the file, or two mappings on one sheet, are file problems)
  const work: { sheet: NamedSheet; mapping: SheetMapping }[] = [];
  const used = new Set<string>();
  for (const [index, sheet] of sheets.entries()) {
    const mapping = mappingForSheet(opts.mappings, sheet.name, sheets.length);
    if (!mapping) report.unmappedSheets.push(sheet.name);
    else {
      // R14-04: the reader never evaluates a formula. A sheet with formula cells is refused unless its mapping explicitly accepts the
      // cached values (which can be stale), and then the report says how many cells were read that way.
      if (sheet.formulaCells > 0 && !mapping.allowCachedFormulaValues)
        report.fileProblems.push(
          `Sheet ${index + 1} has ${sheet.formulaCells} formula cell(s). Formulas are not evaluated and their stored values may be stale: paste the values (Paste Special > Values) and save again, or set "allowCachedFormulaValues": true in this sheet's mapping.`,
        );
      work.push({ sheet, mapping });
      used.add(mapping.sheet);
    }
  }
  for (const m of opts.requireEveryMappedSheet === false ? [] : opts.mappings)
    if (!used.has(m.sheet))
      report.fileProblems.push(`The mapping for sheet "${m.sheet}" matches no sheet of the file.`);
  const perKind = new Map<MappingKind, number>();
  for (const w of work) perKind.set(w.mapping.kind, (perKind.get(w.mapping.kind) ?? 0) + 1);
  for (const [kind, n] of perKind)
    if (n > 1) report.fileProblems.push(`Two sheets are mapped to "${kind}": use one.`);
  if (work.length === 0) report.fileProblems.push('No sheet of the file has a mapping: nothing to import.');
  work.sort((a, b) => APPLY_ORDER.indexOf(a.mapping.kind) - APPLY_ORDER.indexOf(b.mapping.kind));

  const runId = uuidv7(realClock.now());
  report.runId = runId;
  const client = await opts.appPool.connect();
  let ended = false;
  try {
    await client.query('BEGIN');
    const pool = singleTransactionPool(client, runId);

    // idempotency: the same bytes, already imported and not rolled back
    const previous = await findAppliedRun(pool, opts.actor, hash);
    if (previous) {
      report.alreadyImportedRunId = previous;
      ended = true;
      await rollbackAndRelease(client);
      return report;
    }

    for (const { sheet, mapping } of work) {
      const kind = mapping.kind as ImportKind;
      const columns = { ...defaultColumnsOf(kind), ...mapping.columns };
      const r = await runImport(kind, sheet.rows, {
        appPool: pool,
        actor: opts.actor,
        apply: true, // inside the outer transaction: the dry run rolls it back below, and so does any sheet with a problem
        applyValidRows: true, // so that a fault in one sheet does not make every sheet that refers to it look wrong
        columns,
        headerRow: mapping.headerRow,
        dateFormat: mapping.dateFormat,
        defaultPlant: mapping.defaultPlant,
        openingDate: opts.openingDate,
        today: opts.today,
      });
      report.sheets.push({
        sheet: sheet.name,
        kind: mapping.kind,
        report: r,
        formulaCellsRead: mapping.allowCachedFormulaValues ? sheet.formulaCells : 0,
      });
    }

    for (const s of report.sheets) {
      report.totals.rows += s.report.rows.length;
      for (const k of ['new', 'exists', 'error', 'created', 'failed'] as const)
        report.totals[k] += s.report.counts[k];
    }
    const blocked =
      report.fileProblems.length > 0 ||
      report.sheets.some(
        (s) => s.report.missingColumns.length > 0 || s.report.counts.error > 0 || s.report.counts.failed > 0,
      );

    if (opts.mode === 'apply' && !blocked) {
      await withRlsContext(pool, auditContext(opts.actor), (tx) =>
        recordAuditEvent(tx, {
          action: 'import',
          table: 'import',
          rowId: runId,
          // the hash and the counts, never a cell of the file
          after: {
            run_id: runId,
            sha256: hash,
            size_bytes: opts.file.length,
            sheets: report.sheets.map((s) => ({
              kind: s.kind,
              rows: s.report.rows.length,
              created: s.report.counts.created,
              already_there: s.report.counts.exists,
            })),
          },
          reason: 'excel import',
        }),
      );
      // The only COMMIT of the file: a real run with no problem. `applied` is set only AFTER the server confirmed it (R14-03).
      ended = true;
      await commitAndRelease(client);
      report.applied = true;
      return report;
    }
    // Everything else (a dry run, a problem) rolls back, and says so only if the database confirmed it.
    ended = true;
    await rollbackAndRelease(client);
    return report;
  } catch (error) {
    if (!ended) await abandon(client); // an exception: roll back, or destroy the connection; the error itself goes on
    throw error;
  }
}

// The run's tag is added to the request id by the single-transaction pool; the event itself carries the run id in `row_id`.
const auditContext = (actor: SessionUser) => ({
  userId: actor.id,
  role: actor.role,
  requestId: uuidv7(realClock.now()),
  stepUp: actor.stepUpVerified === true ? true : undefined,
});

/** The run that imported these bytes and has not been rolled back since, if any. */
async function findAppliedRun(pool: pg.Pool, actor: SessionUser, hash: string): Promise<string | null> {
  return withRlsContext(pool, auditContext(actor), async (tx) => {
    const { rows } = await tx.query<{ row_id: string }>(
      `select i.row_id from audit_event i
        where i.action = 'import' and i.table_name = 'import' and i.after->>'sha256' = $1
          and not exists (select 1 from audit_event r where r.action = 'reverse' and r.table_name = 'import' and r.row_id = i.row_id)
        order by i.id desc limit 1`,
      [hash],
    );
    return rows[0]?.row_id ?? null;
  });
}

export interface RollbackReport {
  runId: string;
  /** The run was already rolled back: nothing was done. */
  alreadyRolledBack: boolean;
  archived: Record<string, number>;
  cancelledInstruments: number;
  /** Rows the run created that the tool never removes (sealed versions, the books' opening, the invoice sequence): listed by table. */
  staysAsRecorded: Record<string, number>;
  /** Why the rollback did not happen, when it did not (a cheque already moved on). Nothing is changed then. */
  blocked: string[];
}

const ARCHIVABLE = ['client', 'supplier', 'truck', 'concrete_type', 'component'] as const;
// Sealed by design (insert-only versions, the opening of the books, a forward-only sequence): a correction is a newer version or a
// reversing entry from the screen, never a deletion. Child rows of the reversible kinds are not listed.
const SEALED = [
  'selling_price',
  'recette',
  'opening_balance',
  'party_opening_balance',
  'doc_sequence',
] as const;

/**
 * The way back after a file was applied: everything the run CREATED is taken out of use, nothing is deleted. Clients, suppliers,
 * trucks and pumps, concrete types and components are archived; the cheques and LCN it recorded are cancelled (while still only
 * received). What cannot be undone by design is listed, not touched. One transaction, audited as 'reverse' on the run.
 * Before go-live the cleaner way back is the backup taken just before the import (docs/IMPORT-EXCEL.md).
 */
export async function rollbackImport(opts: {
  appPool: pg.Pool;
  actor: SessionUser;
  runId: string;
  environment: ImportEnvironment;
  today?: string;
}): Promise<RollbackReport> {
  assertActor(opts.actor, 'apply');
  await assertImportEnvironment(opts.appPool, opts.environment);
  const today = opts.today ?? realClock.now().toISOString().slice(0, 10);
  const report: RollbackReport = {
    runId: opts.runId,
    alreadyRolledBack: false,
    archived: {},
    cancelledInstruments: 0,
    staysAsRecorded: {},
    blocked: [],
  };
  const rollbackId = uuidv7(realClock.now());
  const client = await opts.appPool.connect();
  let ended = false;
  try {
    await client.query('BEGIN');
    const pool = singleTransactionPool(client, rollbackId);
    await withRlsContext(pool, auditContext(opts.actor), async (tx) => {
      const ran = await tx.query(
        `select 1 from audit_event where action = 'import' and table_name = 'import' and row_id = $1`,
        [opts.runId],
      );
      if (!ran.rows[0]) {
        report.blocked.push('No import with this run id is recorded (or it is not visible to this account).');
        return;
      }
      const undone = await tx.query(
        `select 1 from audit_event where action = 'reverse' and table_name = 'import' and row_id = $1`,
        [opts.runId],
      );
      if (undone.rows[0]) {
        report.alreadyRolledBack = true;
        return;
      }
      const made = await tx.query<{ table_name: string; row_id: string }>(
        `select table_name, row_id from audit_event
          where action = 'insert' and request_id like $1 order by id desc`,
        [`${RUN_TAG_PREFIX}${opts.runId}|%`],
      );
      for (const { table_name: table, row_id: id } of made.rows) {
        if ((ARCHIVABLE as readonly string[]).includes(table)) {
          const done = await tx.query(
            `update ${table} set status = 'archived' where id = $1 and status = 'active' returning id`,
            [id],
          );
          if (done.rows[0]) {
            await tx.query(
              `select audit.record('archive', $1, $2, null, jsonb_build_object('status', 'archived'), 'import rollback')`,
              [table, id],
            );
            report.archived[table] = (report.archived[table] ?? 0) + 1;
          }
        } else if (table === 'payment_instrument') {
          const r = await cancelInstrument(pool, opts.actor, {
            instrumentId: id,
            date: today,
            reason: 'import rollback',
          });
          if (r.ok) report.cancelledInstruments++;
          else
            report.blocked.push(`cheque or LCN ${id}: ${String(r.error)} (it has moved on since the import)`);
        } else if ((SEALED as readonly string[]).includes(table)) {
          report.staysAsRecorded[table] = (report.staysAsRecorded[table] ?? 0) + 1;
        }
      }
    });
    if (report.blocked.length === 0 && !report.alreadyRolledBack) {
      await withRlsContext(pool, auditContext(opts.actor), (tx) =>
        recordAuditEvent(tx, {
          action: 'reverse',
          table: 'import',
          rowId: opts.runId,
          after: {
            run_id: opts.runId,
            archived: report.archived,
            cancelled_instruments: report.cancelledInstruments,
            stays_as_recorded: report.staysAsRecorded,
          },
          reason: 'excel import rollback',
        }),
      );
      ended = true;
      await commitAndRelease(client);
      return report;
    }
    ended = true;
    await rollbackAndRelease(client);
    return report;
  } catch (error) {
    if (!ended) await abandon(client);
    throw error;
  }
}
