import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { createClient } from '@/modules/master-data';
import { recordAuditEvent, type SessionUser } from '@/modules/platform-security';
import { stableJson, type StepUpProof } from '../../domain/confirmation';
import { RUN_TAG_PREFIX, singleTransactionPool } from '../../service/tx-pool';
import { abandon, commitAndRelease, rollbackAndRelease } from '../../service/tx-end';
import { deliveryContamination, expenseContamination } from '../domain/twin-content';
import { assertActor, ImportRefused } from '../../service/workbook-import';
import { type HistoryEnvironment, historyEnvironmentProblem } from '../domain/guard';
import type { HistoryMapping } from '../domain/mapping';
import {
  BUILTIN_CATEGORY_ALIASES,
  BUILTIN_PUMP_ALIASES,
  type CategoryCode,
  categoryKey as categoryKeyOf,
  clientKey as clientKeyOf,
  driverKey as driverKeyOf,
  pumpKey as pumpKeyOf,
  truckKey as truckKeyOf,
  typeKey,
} from '../domain/normalise';
import {
  type DeliveryRow,
  deliveryFromRaw,
  type ExpenseRow,
  expenseFromRaw,
  type MonthStats,
  type SheetStats,
} from '../domain/parse';
import { HISTORY_LOCK_SQL } from './lock';
import { type FileReport, type InputFile, labelUsage, readSet, type SetRead } from './read-set';

// T11 (decision 211): stage, dry-run, apply and rollback of the history importer. The history is its OWN layer (schema `history`): nothing here
// writes to stock, invoices, the ledger, trips, orders or dispatch. One audited transaction, serialized by an advisory lock, bound to the typed
// phrase and the second factor of the operation (the same machinery as the T2 importer). Reports carry counts and row numbers, never a cell.

/**
 * R19-07: the confirmation covers the files (their bytes), the kind, the plant and the mapping (`setSha`) AND the exact effective staging decisions
 * (`decisionsSha`: every label mapping the set uses and every quarantine decision and correction). A decision changed after the confirmation was given
 * changes the hash, and the apply refuses with nothing written.
 */
export const historyConfirmation = (setSha: string, decisionsSha: string) => ({
  phrase: `HISTORY ${setSha} ${decisionsSha.slice(0, 16)}`,
  operation: `history:${setSha}:${decisionsSha}`,
});
export const historyRollbackConfirmation = (batchId: string) => ({
  phrase: `HISTORY-ROLLBACK ${batchId}`,
  operation: `history-rollback:${batchId}`,
});

export interface HistoryReport {
  mode: 'dry-run' | 'stage' | 'apply';
  setSha: string;
  /** R19-07: the hash of the effective staging decisions at the moment of this run (what an apply confirmation must cover). */
  decisionsSha: string;
  /** The operation the typed phrase and the second factor are bound to (apply). */
  operation: string;
  kind: HistoryMapping['kind'];
  batchId: string | null;
  /** True when this call wrote the staging (stage) or the history (apply) and the database confirmed the commit. */
  staged: boolean;
  applied: boolean;
  /** The same files and mapping were already applied by an earlier batch that was not rolled back: nothing was done. */
  alreadyAppliedBatchId: string | null;
  files: FileReport[];
  /** Fixed phrases; empty when the set can be applied once the owner has decided. */
  problems: string[];
  /** Why the apply did not happen (open mappings, open quarantined rows...), by fixed phrase and count. */
  blocked: string[];
  totals: {
    rowsRead: number;
    imported: number;
    quarantined: number;
    blank: number;
    formulaRows: number;
    unmappedColumns: number;
  };
  /** Label keys the owner has not decided yet, by kind. */
  openLabels: Record<string, number>;
  openQuarantine: number;
  created: { clients: number; deliveries: number; expenses: number };
  months: Record<string, MonthStats>;
  blDuplicateRows: number;
  blGaps: number;
  blSuspectRows: number;
}

export interface HistoryOptions {
  appPool: pg.Pool;
  actor: SessionUser;
  files: InputFile[];
  mapping: HistoryMapping;
  environment: HistoryEnvironment;
  mode: HistoryReport['mode'];
  /** Required for apply: the verified code, bound to `historyConfirmation(setSha).operation`. */
  stepUp?: StepUpProof;
}

const auditContext = (actor: SessionUser) => ({
  userId: actor.id,
  role: actor.role,
  requestId: uuidv7(realClock.now()),
  stepUp: actor.stepUpVerified === true ? true : undefined,
});

export async function assertHistoryEnvironment(
  appPool: pg.Pool,
  env: HistoryEnvironment,
  facts: Parameters<typeof historyEnvironmentProblem>[2],
): Promise<void> {
  const seeded =
    (await appPool.query<{ s: boolean }>('select public.training_seeded() as s')).rows[0]?.s === true;
  const problem = historyEnvironmentProblem(env, seeded, facts);
  if (problem) throw new ImportRefused('ENVIRONMENT', problem);
}

function totalsOf(
  read: SetRead,
): HistoryReport['totals'] & { dup: number; gaps: number; suspect: number; months: HistoryReport['months'] } {
  const t = {
    rowsRead: 0,
    imported: 0,
    quarantined: 0,
    blank: 0,
    formulaRows: 0,
    unmappedColumns: 0,
    dup: 0,
    gaps: 0,
    suspect: 0,
    months: {} as HistoryReport['months'],
  };
  for (const f of read.files)
    for (const { stats } of f.read) {
      const s: SheetStats = stats;
      t.rowsRead += s.rowsRead;
      t.imported += s.imported;
      t.quarantined += s.quarantined;
      t.blank += s.blankSkipped;
      t.formulaRows += s.formulaRowsSkipped;
      t.unmappedColumns += s.unmappedColumns;
      t.dup += s.blDuplicateRows.length;
      t.gaps += s.blGaps;
      t.suspect += s.blSuspectRows.length;
      for (const [m, v] of Object.entries(s.months)) {
        const slot = (t.months[m] ??= { rows: 0, litres: 0, qRows: 0, qLitres: 0, cents: 0 });
        slot.rows += v.rows;
        slot.litres += v.litres;
        slot.qRows += v.qRows;
        slot.qLitres += v.qLitres;
        slot.cents += v.cents;
      }
    }
  return t;
}

interface LabelRow {
  kind: string;
  key: string;
  status: string;
  client_id: string | null;
  truck_id: string | null;
  driver_id: string | null;
  canonical: string | null;
  label: string;
}

/** What a new label starts as: a type that is already a concrete type code, a built-in pump or category word are decided; the rest waits for the owner. */
function autoDecision(
  kind: string,
  key: string,
  typeCodes: Map<string, string>,
): { status: 'mapped'; canonical: string } | null {
  if (kind === 'type' && typeCodes.has(key))
    return { status: 'mapped', canonical: typeCodes.get(key) as string };
  if (kind === 'pump' && key in BUILTIN_PUMP_ALIASES)
    return { status: 'mapped', canonical: BUILTIN_PUMP_ALIASES[key] as string };
  if (kind === 'category' && key in BUILTIN_CATEGORY_ALIASES)
    return { status: 'mapped', canonical: BUILTIN_CATEGORY_ALIASES[key] as CategoryCode };
  return null;
}

/** Quarantined rows the owner fixed are read like any row, with the owner's values over the raw cells. */
async function fixedRows(
  tx: pg.PoolClient,
  setSha: string,
  mapping: HistoryMapping,
): Promise<{
  deliveries: DeliveryRow[];
  expenses: ExpenseRow[];
  invalid: number;
  open: number;
  decisions: unknown[];
}> {
  const { rows } = await tx.query<{
    file_ord: number;
    sheet_pos: number;
    row_no: number;
    raw: Record<string, string>;
    fixed: Record<string, string> | null;
    status: string;
  }>(
    `select file_ord, sheet_pos, row_no, raw, fixed, status from history.quarantine where set_sha = $1 and kind = $2 and purged_at is null order by file_ord, sheet_pos, row_no`,
    [setSha, mapping.kind],
  );
  const out = {
    deliveries: [] as DeliveryRow[],
    expenses: [] as ExpenseRow[],
    invalid: 0,
    open: 0,
    decisions: [] as unknown[],
  };
  for (const q of rows) {
    out.decisions.push([q.file_ord, q.sheet_pos, q.row_no, q.status, q.fixed]);
    if (q.status === 'open') out.open++;
    if (q.status !== 'fixed' || !q.fixed) continue;
    const src = { file: q.file_ord, sheet: q.sheet_pos, row: q.row_no };
    const raw = { ...q.raw, ...q.fixed };
    if (mapping.kind === 'deliveries') {
      const b = deliveryFromRaw(raw, src, mapping.dateFormat);
      if ('row' in b) out.deliveries.push(b.row);
      else out.invalid++;
    } else {
      const b = expenseFromRaw(raw, src, mapping.dateFormat, mapping.fileMonths[String(src.file)] ?? null);
      if ('row' in b) out.expenses.push(b.row);
      else out.invalid++;
    }
  }
  return out;
}

async function insertMany(
  tx: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  suffix = '',
): Promise<void> {
  const size = Math.max(1, Math.floor(30000 / columns.length));
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`);
    await tx.query(
      `insert into ${table} (${columns.join(',')}) values ${values.join(',')} ${suffix}`,
      params,
    );
  }
}

const str = (v: string) => (v === '' ? null : v);

/** Stages, validates (dry run) or applies one set of monthly files of one plant and one kind. */
export async function runHistory(opts: HistoryOptions): Promise<HistoryReport> {
  const { mapping } = opts;
  const read = readSet(opts.files, mapping);
  // the role first; the proof of an apply is checked below, once the effective decisions are known (it covers them)
  assertActor(opts.actor, 'dry-run');
  if (opts.mode === 'apply' && opts.actor.stepUpVerified !== true)
    assertActor(opts.actor, 'apply', { given: opts.stepUp, operation: '' });
  await assertHistoryEnvironment(opts.appPool, opts.environment, read.facts);
  const t = totalsOf(read);
  const report: HistoryReport = {
    mode: opts.mode,
    setSha: read.setSha,
    decisionsSha: '',
    operation: '',
    kind: mapping.kind,
    batchId: null,
    staged: false,
    applied: false,
    alreadyAppliedBatchId: null,
    files: read.files,
    problems: [
      ...read.problems,
      ...read.files.flatMap((f) =>
        f.problems.filter((p) => !p.startsWith('SHEET_NO_DATE_COLUMN')).map((p) => `file ${f.file}: ${p}`),
      ),
    ],
    blocked: [],
    totals: {
      rowsRead: t.rowsRead,
      imported: t.imported,
      quarantined: t.quarantined,
      blank: t.blank,
      formulaRows: t.formulaRows,
      unmappedColumns: t.unmappedColumns,
    },
    openLabels: {},
    openQuarantine: 0,
    created: { clients: 0, deliveries: 0, expenses: 0 },
    months: t.months,
    blDuplicateRows: t.dup,
    blGaps: t.gaps,
    blSuspectRows: t.suspect,
  };

  const batchId = uuidv7(realClock.now());
  const client = await opts.appPool.connect();
  let ended = false;
  try {
    await client.query('BEGIN');
    await client.query(HISTORY_LOCK_SQL);
    const pool = singleTransactionPool(client, batchId);

    const state = await withRlsContext(pool, auditContext(opts.actor), async (tx) => {
      const plant = mapping.plantCode
        ? ((
            await tx.query<{ id: string }>(`select id from plant where code = $1 and status = 'active'`, [
              mapping.plantCode,
            ])
          ).rows[0]?.id ?? null)
        : null;
      const batch = (
        await tx.query<{ id: string; status: string; operation: string | null }>(
          `select id, status, operation from history.batch where set_sha = $1 and kind = $2 and status <> 'rolled_back'`,
          [read.setSha, mapping.kind],
        )
      ).rows[0];
      const fixed = batch
        ? await fixedRows(tx, read.setSha, mapping)
        : { deliveries: [], expenses: [], invalid: 0, open: 0, decisions: [] as unknown[] };
      // the rows that will be written: the readable ones and the quarantined ones the owner fixed (not the open or discarded ones)
      const effective: SetRead = {
        ...read,
        quarantine: [],
        deliveries: [...read.deliveries, ...fixed.deliveries],
        expenses: [...read.expenses, ...fixed.expenses],
      };
      // staging and the dry run also list the labels of quarantined rows (the owner decides them up front); the apply checks only what it writes
      const usageAll = labelUsage({ ...effective, quarantine: read.quarantine });
      const usage = opts.mode === 'apply' ? labelUsage(effective) : usageAll;
      const known = new Map<string, LabelRow>();
      for (const kind of new Set([...usageAll.values()].map((u) => u.kind))) {
        const { rows } = await tx.query<LabelRow>(
          `select kind, key, status, client_id, truck_id, driver_id, canonical, label from history.label_map where kind = $1`,
          [kind],
        );
        for (const r of rows) known.set(`${r.kind}\u0000${r.key}`, r);
      }
      return { plant, batch, fixed, effective, usage, usageAll, known };
    });
    // R19-03: on the training instance the EFFECTIVE values that will be written (the readable rows and the corrections the owner made after staging) are
    // validated again against what the twin can write; a marker proved nothing at stage time and a correction is typed text.
    if (opts.environment.trainingMode && opts.mode !== 'dry-run') {
      const bad = [
        ...state.effective.deliveries.flatMap(deliveryContamination),
        ...state.effective.expenses.flatMap(expenseContamination),
      ];
      if (bad.length > 0)
        throw new ImportRefused(
          'ENVIRONMENT',
          `A value to write is outside what the twin generator can write (fields: ${[...new Set(bad)].join(', ')}): refused on the training instance.`,
        );
    }
    // R19-07: the effective decisions, read under the history lock in this transaction: every label the set uses (as decided, or as it would start) and every
    // quarantine decision and correction of the set. The confirmation of an apply must cover exactly this.
    report.decisionsSha = createHash('sha256')
      .update(
        stableJson({
          v: 1,
          labels: [...state.usageAll.keys()].sort().map((id) => {
            const r = state.known.get(id);
            return [
              id,
              r
                ? [
                    r.status,
                    r.client_id ?? null,
                    r.truck_id ?? null,
                    r.driver_id ?? null,
                    r.canonical ?? null,
                  ]
                : 'undecided',
            ];
          }),
          quarantine: state.fixed.decisions,
        }),
      )
      .digest('hex');
    {
      const conf = historyConfirmation(read.setSha, report.decisionsSha);
      report.operation = conf.operation;
      // a batch already applied is only reported (nothing is written): its decisions moved when it was applied, and the proof of the run that applied it stands
      if (opts.mode === 'apply' && state.batch?.status !== 'applied') {
        if (
          opts.stepUp?.operation?.startsWith(`history:${read.setSha}:`) &&
          opts.stepUp.operation !== conf.operation
        )
          throw new ImportRefused(
            'STEP_UP_REQUIRED',
            'The staging decisions (mappings or corrections) changed after the confirmation was given: nothing was done.',
          );
        assertActor(opts.actor, 'apply', { given: opts.stepUp, operation: conf.operation });
      }
    }
    if (mapping.plantCode && !state.plant)
      report.problems.push(`PLANT_UNKNOWN: no active plant has the configured code`);
    if (state.fixed.invalid) report.blocked.push(`FIXED_ROWS_INVALID: ${state.fixed.invalid}`);

    // label keys the owner has not decided: not in the map yet, or pending
    const typeCodes = new Map<string, string>(
      (
        await withRlsContext(pool, auditContext(opts.actor), (tx) =>
          tx.query<{ code: string }>(`select code from concrete_type where status = 'active'`),
        )
      ).rows.map((r) => [typeKey(r.code), r.code]),
    );
    for (const [id, u] of state.usage) {
      const row = state.known.get(id);
      const auto = row ? null : autoDecision(u.kind, u.key, typeCodes);
      if ((!row && !auto) || row?.status === 'pending')
        report.openLabels[u.kind] = (report.openLabels[u.kind] ?? 0) + 1;
    }
    report.openQuarantine = state.batch ? state.fixed.open : report.totals.quarantined;
    report.batchId = state.batch?.id ?? null;
    const readable = report.problems.length === 0;

    if (opts.mode === 'stage' && readable) {
      if (!state.batch) {
        const id = batchId;
        await withRlsContext(pool, auditContext(opts.actor), async (tx) => {
          await tx.query(
            `insert into history.batch (id, kind, plant_id, set_sha, files, read_stats, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              id,
              mapping.kind,
              state.plant,
              read.setSha,
              opts.files.length,
              JSON.stringify(t.months),
              opts.actor.id,
            ],
          );
          const newLabels = [...state.usage.entries()].filter(([k]) => !state.known.has(k));
          await insertMany(
            tx,
            'history.label_map',
            ['id', 'kind', 'key', 'label', 'uses', 'status', 'canonical', 'created_by'],
            newLabels.map(([, u]) => {
              const auto = autoDecision(u.kind, u.key, typeCodes);
              return [
                uuidv7(realClock.now()),
                u.kind,
                u.key,
                u.label,
                u.uses,
                auto ? 'mapped' : 'pending',
                auto?.canonical ?? null,
                opts.actor.id,
              ];
            }),
          );
          // the same files staged again after their batch was discarded: the rows that batch discarded come back as open, the others are untouched
          await tx.query(
            `update history.quarantine set status = 'open', batch_discarded = false, fixed = null, decided_by = null, decided_at = null
              where set_sha = $1 and kind = $2 and batch_discarded and purged_at is null`,
            [read.setSha, mapping.kind],
          );
          await insertMany(
            tx,
            'history.quarantine',
            ['id', 'set_sha', 'kind', 'plant_id', 'file_ord', 'sheet_pos', 'row_no', 'reason', 'raw'],
            read.quarantine.map((q) => [
              uuidv7(realClock.now()),
              read.setSha,
              q.kind,
              state.plant,
              q.src.file,
              q.src.sheet,
              q.src.row,
              q.reason,
              JSON.stringify(q.raw),
            ]),
            'on conflict (set_sha, kind, file_ord, sheet_pos, row_no) where purged_at is null do nothing',
          );
          await recordAuditEvent(tx, {
            action: 'import',
            table: 'history_import',
            rowId: id,
            after: {
              batch_id: id,
              stage: true,
              set_sha: read.setSha,
              kind: mapping.kind,
              rows_read: t.rowsRead,
              quarantined: t.quarantined,
            },
            reason: 'history import staged',
          });
        });
        report.batchId = id;
        report.staged = true;
        ended = true;
        await commitAndRelease(client);
        return report;
      }
      // the same set staged again: nothing changes, the owner's decisions stand
      report.staged = false;
    }

    if (opts.mode === 'apply' && readable) {
      if (!state.batch)
        report.blocked.push('NOT_STAGED: stage this set first (the staging screens decide what apply needs)');
      else if (state.batch.status === 'applied') report.alreadyAppliedBatchId = state.batch.id;
      else {
        const open = Object.values(report.openLabels).reduce((a, b) => a + b, 0);
        if (open) report.blocked.push(`OPEN_MAPPINGS: ${open}`);
        if (state.fixed.open) report.blocked.push(`OPEN_QUARANTINE: ${state.fixed.open}`);
        if (!report.blocked.length && state.plant === null && mapping.plantCode)
          report.blocked.push('PLANT_UNKNOWN');
      }
      if (state.batch && state.batch.status === 'staged' && !report.blocked.length) {
        const bid = state.batch.id;
        // new clients first (through the client service, as the screens do), tagged with the batch so the rollback finds them again
        const taggedPool = singleTransactionPool(client, bid);
        for (const [id, u] of state.usage) {
          if (u.kind !== 'client') continue;
          const row = state.known.get(id);
          if (row?.status !== 'new') continue;
          const made = await createClient(taggedPool, opts.actor, {
            name: u.label,
            kind: 'person',
            notes: 'Created by the history import',
          });
          if (!made.ok) {
            report.blocked.push('CLIENT_CREATE_FAILED');
            continue;
          }
          row.client_id = made.value.client.id;
          row.status = 'mapped';
          report.created.clients++;
          await withRlsContext(taggedPool, auditContext(opts.actor), (tx) =>
            tx.query(
              `update history.label_map set status = 'mapped', client_id = $1, decided_by = $2, decided_at = clock_timestamp() where kind = 'client' and key = $3`,
              [made.value.client.id, opts.actor.id, u.key],
            ),
          );
        }
        if (!report.blocked.length) {
          const at = (kind: string, key: string | null) =>
            key ? state.known.get(`${kind}\u0000${key}`) : undefined;
          await withRlsContext(taggedPool, auditContext(opts.actor), async (tx) => {
            if (mapping.kind === 'deliveries') {
              const rows = state.effective.deliveries.map((r) => {
                const c = at('client', r.client ? clientKeyOf(r.client) : null);
                const tr = at('truck', r.truck ? truckKeyOf(r.truck) : null);
                const dr = at('driver', r.driver ? driverKeyOf(r.driver) : null);
                const ty = at('type', r.typeRaw ? typeKey(r.typeRaw) : null);
                const pu = at('pump', r.pumpRaw ? pumpKeyOf(r.pumpRaw) : null);
                return [
                  uuidv7(realClock.now()),
                  bid,
                  state.plant,
                  r.date,
                  r.volumeL,
                  str(r.client),
                  c?.status === 'mapped' ? c.client_id : null,
                  str(r.site),
                  str(r.typeRaw),
                  ty?.status === 'mapped' ? ty.canonical : null,
                  pu?.status === 'mapped' ? pu.canonical : 'unknown',
                  str(r.truck),
                  tr?.status === 'mapped' ? tr.truck_id : null,
                  str(r.driver),
                  dr?.status === 'mapped' ? dr.driver_id : null,
                  str(r.bl),
                  r.blSuspect,
                  r.taxBasis,
                  str(r.note),
                  JSON.stringify(r.legacy),
                  r.src.file,
                  r.src.sheet,
                  r.src.row,
                  opts.actor.id,
                ];
              });
              await insertMany(
                tx,
                'history.delivery',
                [
                  'id',
                  'batch_id',
                  'plant_id',
                  'delivery_date',
                  'volume_l',
                  'client_raw',
                  'client_id',
                  'site_raw',
                  'type_raw',
                  'type_code',
                  'pump_mode',
                  'truck_raw',
                  'truck_id',
                  'driver_raw',
                  'driver_id',
                  'bl_raw',
                  'bl_suspect',
                  'tax_basis',
                  'note',
                  'legacy',
                  'src_file',
                  'src_sheet',
                  'src_row',
                  'created_by',
                ],
                rows,
              );
              report.created.deliveries = rows.length;
            } else {
              const rows = state.effective.expenses.map((r) => {
                const cat = at('category', categoryKeyOf(r.label));
                const tr = at('truck', r.truck ? truckKeyOf(r.truck) : null);
                return [
                  uuidv7(realClock.now()),
                  bid,
                  state.plant,
                  r.date,
                  r.month,
                  cat?.status === 'mapped' ? cat.canonical : 'other',
                  r.label,
                  r.quantityMl,
                  r.amountCentimes,
                  str(r.truck),
                  tr?.status === 'mapped' ? tr.truck_id : null,
                  JSON.stringify(r.legacy),
                  r.src.file,
                  r.src.sheet,
                  r.src.row,
                  opts.actor.id,
                ];
              });
              await insertMany(
                tx,
                'history.expense',
                [
                  'id',
                  'batch_id',
                  'plant_id',
                  'expense_date',
                  'expense_month',
                  'category_code',
                  'label_raw',
                  'quantity_ml',
                  'amount_centimes',
                  'truck_raw',
                  'truck_id',
                  'legacy',
                  'src_file',
                  'src_sheet',
                  'src_row',
                  'created_by',
                ],
                rows,
              );
              report.created.expenses = rows.length;
            }
            await tx.query(
              `update history.batch set status = 'applied', applied_by = $2, applied_at = clock_timestamp(), operation = $3, counts = $4 where id = $1`,
              [bid, opts.actor.id, report.operation, JSON.stringify(report.created)],
            );
            // the hash and the counts, never a cell of the files
            await recordAuditEvent(tx, {
              action: 'import',
              table: 'history_import',
              rowId: bid,
              after: {
                batch_id: bid,
                set_sha: read.setSha,
                operation: report.operation,
                kind: mapping.kind,
                created: report.created,
                quarantined_fixed: state.fixed.deliveries.length + state.fixed.expenses.length,
              },
              reason: 'history import applied',
            });
          });
          report.batchId = bid;
          ended = true;
          await commitAndRelease(client);
          report.applied = true;
          return report;
        }
      }
    }
    ended = true;
    await rollbackAndRelease(client);
    return report;
  } catch (error) {
    if (!ended) await abandon(client);
    throw error;
  }
}

export interface HistoryRollbackReport {
  batchId: string;
  alreadyRolledBack: boolean;
  archivedClients: number;
  /** R19-08: clients this batch created that are KEPT active because something outside the batch uses them (a later order, a quote, an invoice...) or another batch's history is attributed to them. */
  retainedClients: number;
  blocked: string[];
}

/** The way back: the batch is marked rolled back (its rows stay, no report reads them), the clients it created are archived. Nothing is deleted; the staging decisions stay. */
export async function rollbackHistory(opts: {
  appPool: pg.Pool;
  actor: SessionUser;
  batchId: string;
  environment: HistoryEnvironment;
  stepUp?: StepUpProof;
}): Promise<HistoryRollbackReport> {
  assertActor(opts.actor, 'apply', {
    given: opts.stepUp,
    operation: historyRollbackConfirmation(opts.batchId).operation,
  });
  await assertHistoryEnvironment(opts.appPool, opts.environment, []);
  const report: HistoryRollbackReport = {
    batchId: opts.batchId,
    alreadyRolledBack: false,
    archivedClients: 0,
    retainedClients: 0,
    blocked: [],
  };
  const rollbackId = uuidv7(realClock.now());
  const client = await opts.appPool.connect();
  let ended = false;
  try {
    await client.query('BEGIN');
    await client.query(HISTORY_LOCK_SQL);
    const pool = singleTransactionPool(client, rollbackId);
    await withRlsContext(pool, auditContext(opts.actor), async (tx) => {
      const b = (
        await tx.query<{ status: string }>(`select status from history.batch where id = $1`, [opts.batchId])
      ).rows[0];
      if (!b) return void report.blocked.push('NO_SUCH_BATCH');
      if (b.status === 'rolled_back') return void (report.alreadyRolledBack = true);
      if (b.status === 'staged') {
        // R18 4B: a batch that was only STAGED is reversed too: nothing was applied, so no client was created and no row exists; the quarantined rows of the
        // set are marked discarded BY THE BATCH (staging the same files again reopens them); nothing is deleted
        const set = (
          await tx.query<{ set_sha: string; kind: string }>(
            `select set_sha, kind from history.batch where id = $1`,
            [opts.batchId],
          )
        ).rows[0]!;
        await tx.query(
          `update history.quarantine set status = 'discarded', batch_discarded = true, decided_by = $3, decided_at = clock_timestamp()
            where set_sha = $1 and kind = $2 and status in ('open', 'fixed') and purged_at is null`,
          [set.set_sha, set.kind, opts.actor.id],
        );
        await tx.query(
          `update history.batch set status = 'rolled_back', rolled_back_by = $2, rolled_back_at = clock_timestamp() where id = $1`,
          [opts.batchId, opts.actor.id],
        );
        await recordAuditEvent(tx, {
          action: 'reverse',
          table: 'history_import',
          rowId: opts.batchId,
          after: { batch_id: opts.batchId, staged_only: true },
          reason: 'history staging discarded',
        });
        return;
      }
      if (b.status !== 'applied') return void report.blocked.push('NOT_APPLIED');
      const made = await tx.query<{ row_id: string }>(
        `select row_id from audit_event where action = 'insert' and table_name = 'client' and request_id like $1`,
        [`${RUN_TAG_PREFIX}${opts.batchId}|%`],
      );
      // R19-08: a client the batch created is archived only when NOTHING ELSE uses it. Anything that references it from outside this batch (a later order, quote,
      // invoice, credit note, payment instrument, pump job, price, site, credit limit, opening balance), or another live batch's history attributed to it, keeps it
      // active: reversing an unrelated historical batch must not take a live client out of new orders. The mapping of its label stays as it is (it stays usable).
      const REFERENCES = [
        'avoir',
        'client_credit_limit',
        'client_site',
        'invoice',
        'opening_party_balance',
        'payment_instrument',
        'pump_job',
        'quote',
        'sales_order',
        'selling_price',
      ];
      const usedElsewhere = async (id: string): Promise<boolean> => {
        for (const table of REFERENCES) {
          const r = await tx.query(`select 1 from public.${table} where client_id = $1 limit 1`, [id]);
          if (r.rowCount) return true;
        }
        const other = await tx.query(
          `select 1 from history.delivery d join history.batch ob on ob.id = d.batch_id
            where d.client_id = $1 and d.batch_id <> $2 and ob.status <> 'rolled_back' limit 1`,
          [id, opts.batchId],
        );
        return (other.rowCount ?? 0) > 0;
      };
      for (const { row_id: id } of made.rows) {
        if (await usedElsewhere(id)) {
          report.retainedClients++;
          continue;
        }
        const done = await tx.query(
          `update client set status = 'archived' where id = $1 and status = 'active' returning id`,
          [id],
        );
        if (done.rows[0]) {
          await tx.query(
            `select audit.record('archive', 'client', $1, null, jsonb_build_object('status', 'archived'), 'history import rollback')`,
            [id],
          );
          report.archivedClients++;
        }
      }
      await tx.query(
        `update history.batch set status = 'rolled_back', rolled_back_by = $2, rolled_back_at = clock_timestamp() where id = $1`,
        [opts.batchId, opts.actor.id],
      );
      await recordAuditEvent(tx, {
        action: 'reverse',
        table: 'history_import',
        rowId: opts.batchId,
        after: {
          batch_id: opts.batchId,
          archived_clients: report.archivedClients,
          retained_clients: report.retainedClients,
        },
        reason: 'history import rollback',
      });
    });
    if (report.blocked.length === 0 && !report.alreadyRolledBack) {
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

export const historyPurgeConfirmation = {
  phrase: 'HISTORY-PURGE-STAGING',
  operation: 'history-purge-staging',
};

/**
 * Retention (gate G3): irreversibly clears the label texts and keys and the raw quarantine cells of discarded or rolled-back staging (see migration 0228 for the
 * exact scope). Owner or app_admin, a fresh second factor bound to this operation, one audited transaction, counts only. Nothing of the business or the history
 * rows is touched.
 */
export async function purgeStaging(opts: {
  appPool: pg.Pool;
  actor: SessionUser;
  environment: HistoryEnvironment;
  stepUp?: StepUpProof;
}): Promise<{ quarantineRowsPurged: number; labelsPurged: number }> {
  assertActor(opts.actor, 'apply', { given: opts.stepUp, operation: historyPurgeConfirmation.operation });
  await assertHistoryEnvironment(opts.appPool, opts.environment, []);
  const client = await opts.appPool.connect();
  let ended = false;
  try {
    await client.query('BEGIN');
    await client.query(HISTORY_LOCK_SQL);
    const pool = singleTransactionPool(client, uuidv7(realClock.now()));
    const counts = await withRlsContext(pool, auditContext(opts.actor), async (tx) => {
      const r = await tx.query<{ c: { quarantine_rows_purged: number; labels_purged: number } }>(
        'select history.purge_staging() as c',
      );
      return r.rows[0]!.c;
    });
    ended = true;
    await commitAndRelease(client);
    return { quarantineRowsPurged: counts.quarantine_rows_purged, labelsPurged: counts.labels_purged };
  } catch (error) {
    if (!ended) await abandon(client);
    throw error;
  }
}

export const sha256Hex = (v: unknown): string => createHash('sha256').update(stableJson(v)).digest('hex');
