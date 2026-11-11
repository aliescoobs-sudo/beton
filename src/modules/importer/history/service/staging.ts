import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { realClock } from '@/modules/clock';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { CATEGORY_CODES, similarityGroups } from '../domain/normalise';
import { HISTORY_LOCK_SQL } from './lock';
import { rawContamination } from '../domain/twin-content';
import { deliveryFromRaw, expenseFromRaw } from '../domain/parse';
import type { HistoryMapping } from '../domain/mapping';

// T11: what the owner decides on the History screens (labels to map, rows in quarantine) and what the screens read back. Every function checks
// its permission again (layer 2), and every read goes through row-level security or a definer door that validates the actor.

export type LabelKind = 'client' | 'truck' | 'driver' | 'type' | 'pump' | 'category';
export interface LabelRow {
  id: string;
  kind: LabelKind;
  key: string;
  label: string;
  uses: number;
  status: 'pending' | 'mapped' | 'new' | 'label_only' | 'unknown';
  clientId: string | null;
  truckId: string | null;
  driverId: string | null;
  canonical: string | null;
}
export type HistoryError = 'INVALID' | 'NOT_FOUND';

const decision = z.union([
  z
    .object({
      kind: z.literal('client'),
      key: z.string().min(1),
      status: z.literal('mapped'),
      clientId: z.uuid(),
    })
    .strict(),
  z
    .object({ kind: z.literal('client'), key: z.string().min(1), status: z.enum(['new', 'label_only']) })
    .strict(),
  z
    .object({
      kind: z.literal('truck'),
      key: z.string().min(1),
      status: z.literal('mapped'),
      truckId: z.uuid(),
    })
    .strict(),
  z.object({ kind: z.literal('truck'), key: z.string().min(1), status: z.literal('unknown') }).strict(),
  z
    .object({
      kind: z.literal('driver'),
      key: z.string().min(1),
      status: z.literal('mapped'),
      driverId: z.uuid(),
    })
    .strict(),
  z.object({ kind: z.literal('driver'), key: z.string().min(1), status: z.literal('label_only') }).strict(),
  z
    .object({
      kind: z.literal('type'),
      key: z.string().min(1),
      status: z.literal('mapped'),
      canonical: z.string().regex(/^[A-Z0-9]{1,20}$/),
    })
    .strict(),
  z.object({ kind: z.literal('type'), key: z.string().min(1), status: z.literal('unknown') }).strict(),
  z
    .object({
      kind: z.literal('pump'),
      key: z.string().min(1),
      status: z.literal('mapped'),
      canonical: z.enum(['pump', 'chute', 'unknown']),
    })
    .strict(),
  z.object({ kind: z.literal('pump'), key: z.string().min(1), status: z.literal('unknown') }).strict(),
  z
    .object({
      kind: z.literal('category'),
      key: z.string().min(1),
      status: z.literal('mapped'),
      canonical: z.enum(CATEGORY_CODES),
    })
    .strict(),
  z.object({ kind: z.literal('category'), key: z.string().min(1), status: z.literal('unknown') }).strict(),
]);

/** The owner's decision on one label (map it, create it, keep the label, or say unknown). Decisions are audited; they apply to the next apply. */
export async function decideLabel(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<true, HistoryError>> {
  await require(appPool, actor, 'history.admin');
  const parsed = decision.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const d = parsed.data;
  return inRequest(appPool, actor, async (tx) => {
    await tx.query(HISTORY_LOCK_SQL); // R19-07: a decision waits for an apply in progress and cannot slip in between its reads and its writes
    const { rowCount } = await tx.query(
      `update history.label_map set status = $3, client_id = $4, truck_id = $5, driver_id = $6, canonical = $7, decided_by = $8, decided_at = clock_timestamp()
        where kind = $1 and key = $2`,
      [
        d.kind,
        d.key,
        d.status,
        'clientId' in d ? d.clientId : null,
        'truckId' in d ? d.truckId : null,
        'driverId' in d ? d.driverId : null,
        'canonical' in d ? d.canonical : null,
        actor.id,
      ],
    );
    return rowCount ? ok(true as const) : err('NOT_FOUND' as const);
  });
}

/** Labels to decide (or already decided) for one kind; clients come with their similarity groups (a suggestion, never a merge). */
export async function listLabels(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { kind: LabelKind; onlyOpen?: boolean },
): Promise<{ labels: LabelRow[]; groups: string[][] }> {
  await require(appPool, actor, 'history.admin');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      kind: LabelKind;
      key: string;
      label: string;
      uses: number;
      status: LabelRow['status'];
      client_id: string | null;
      truck_id: string | null;
      driver_id: string | null;
      canonical: string | null;
    }>(
      `select id, kind, key, label, uses, status, client_id, truck_id, driver_id, canonical from history.label_map
        where kind = $1 and ($2::boolean is not true or status = 'pending') order by key limit 2000`,
      [input.kind, input.onlyOpen ?? false],
    );
    const labels = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      key: r.key,
      label: r.label,
      uses: r.uses,
      status: r.status,
      clientId: r.client_id,
      truckId: r.truck_id,
      driverId: r.driver_id,
      canonical: r.canonical,
    }));
    return { labels, groups: input.kind === 'client' ? similarityGroups(labels.map((l) => l.key)) : [] };
  });
}

export interface QuarantineRow {
  id: string;
  kind: 'deliveries' | 'expenses';
  fileOrd: number;
  sheetPos: number;
  rowNo: number;
  reason: string;
  raw: Record<string, string>;
  status: 'open' | 'fixed' | 'discarded';
  fixed: Record<string, string> | null;
}

export async function listQuarantine(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { onlyOpen?: boolean } = {},
): Promise<QuarantineRow[]> {
  await require(appPool, actor, 'history.admin');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      kind: QuarantineRow['kind'];
      file_ord: number;
      sheet_pos: number;
      row_no: number;
      reason: string;
      raw: Record<string, string>;
      status: QuarantineRow['status'];
      fixed: Record<string, string> | null;
    }>(
      `select id, kind, file_ord, sheet_pos, row_no, reason, raw, status, fixed from history.quarantine
        where ($1::boolean is not true or status = 'open') order by created_at, file_ord, row_no limit 2000`,
      [input.onlyOpen ?? false],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      fileOrd: r.file_ord,
      sheetPos: r.sheet_pos,
      rowNo: r.row_no,
      reason: r.reason,
      raw: r.raw,
      status: r.status,
      fixed: r.fixed,
    }));
  });
}

const fixInput = z.object({
  id: z.uuid(),
  action: z.enum(['fix', 'discard']),
  /** The corrected cells by field name (date, m3, amount, label...). Only fields the sheet has; the rest stays as it was read. */
  values: z.record(z.string().regex(/^[a-z0-9_:]{1,30}$/), z.string().max(300)).optional(),
});

/** Fix a quarantined row (the corrected values are re-checked by the same parser; they must make a readable row) or discard it. */
export async function decideQuarantine(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  mapping?: Pick<HistoryMapping, 'dateFormat' | 'fileMonths'>,
  /** R19-03: on the training instance a correction must be something the twin can write, checked when it is typed (and again when it is applied). */
  options: { trainingMode?: boolean } = {},
): Promise<Result<true, HistoryError>> {
  await require(appPool, actor, 'history.admin');
  const parsed = fixInput.safeParse(input);
  if (!parsed.success || (parsed.data.action === 'fix' && !parsed.data.values)) return err('INVALID');
  const d = parsed.data;
  return inRequest(appPool, actor, async (tx) => {
    await tx.query(HISTORY_LOCK_SQL); // R19-07 (see decideLabel)
    const q = (
      await tx.query<{
        kind: QuarantineRow['kind'];
        raw: Record<string, string>;
        file_ord: number;
        sheet_pos: number;
        row_no: number;
        status: string;
      }>(
        `select kind, raw, file_ord, sheet_pos, row_no, status from history.quarantine where id = $1 for update`,
        [d.id],
      )
    ).rows[0];
    if (!q) return err('NOT_FOUND' as const);
    if (d.action === 'fix') {
      const raw = { ...q.raw, ...d.values };
      const src = { file: q.file_ord, sheet: q.sheet_pos, row: q.row_no };
      const fmt = mapping?.dateFormat ?? 'dmy';
      const built =
        q.kind === 'deliveries'
          ? deliveryFromRaw(raw, src, fmt)
          : expenseFromRaw(raw, src, fmt, mapping?.fileMonths[String(src.file)] ?? null);
      if (!('row' in built)) return err('INVALID' as const);
      if (options.trainingMode && rawContamination(q.kind, d.values ?? {}).length > 0)
        return err('INVALID' as const);
    }
    await tx.query(
      `update history.quarantine set status = $2, fixed = $3, decided_by = $4, decided_at = $5 where id = $1`,
      [
        d.id,
        d.action === 'fix' ? 'fixed' : 'discarded',
        d.action === 'fix' ? JSON.stringify(d.values) : null,
        actor.id,
        realClock.now(),
      ],
    );
    return ok(true as const);
  });
}

export interface ReconRow {
  batchId: string;
  kind: 'deliveries' | 'expenses';
  status: 'staged' | 'applied' | 'rolled_back';
  plantCode: string | null;
  month: string;
  rowsRead: number;
  rowsQuarantined: number;
  rowsImported: number;
  /** Litres (deliveries) or centimes (expenses): the sum read from the sheet and the sum imported, so the owner compares them with the Excel's totals cell. */
  quantityRead: number;
  quantityImported: number;
}

/** Per plant and month: rows read, imported, quarantined, SUM read vs imported (the owner's panel to compare with each Excel's totals). */
export async function reconciliation(appPool: pg.Pool, actor: SessionUser): Promise<ReconRow[]> {
  await require(appPool, actor, 'history.admin');
  return inRequest(appPool, actor, async (tx) => {
    const batches = await tx.query<{
      id: string;
      kind: ReconRow['kind'];
      status: ReconRow['status'];
      read_stats: Record<string, { rows: number; litres: number; qRows: number; cents: number }>;
      code: string | null;
    }>(
      `select b.id, b.kind, b.status, b.read_stats, p.code from history.batch b left join public.plant p on p.id = b.plant_id order by b.created_at`,
    );
    const imported = new Map<string, { rows: number; qty: number }>();
    for (const [table, expr, key] of [
      ['delivery', 'sum(volume_l)', "to_char(delivery_date, 'YYYY-MM')"],
      ['expense', 'sum(amount_centimes)', 'expense_month'],
    ] as const) {
      const { rows } = await tx.query<{ batch_id: string; m: string; n: string; q: string }>(
        `select batch_id, ${key} as m, count(*) as n, ${expr} as q from history.${table} group by 1, 2`,
      );
      for (const r of rows) imported.set(`${r.batch_id}|${r.m}`, { rows: Number(r.n), qty: Number(r.q) });
    }
    return batches.rows.flatMap((b) =>
      Object.entries(b.read_stats)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([month, v]) => {
          const i = imported.get(`${b.id}|${month}`);
          return {
            batchId: b.id,
            kind: b.kind,
            status: b.status,
            plantCode: b.code,
            month,
            rowsRead: v.rows,
            rowsQuarantined: v.qRows,
            rowsImported: i?.rows ?? 0,
            quantityRead: b.kind === 'deliveries' ? v.litres : v.cents,
            quantityImported: i?.qty ?? 0,
          };
        }),
    );
  });
}

/* ---- reads through the definer doors (plant managers see their plant only; a row with no plant is not theirs) ---- */
export interface VolumeRow {
  plantId: string | null;
  month: string;
  typeCode: string;
  pumpMode: string;
  rows: number;
  volumeL: number;
}
export async function historyVolume(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string },
): Promise<VolumeRow[]> {
  await require(appPool, actor, 'history.read');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{
      plant_id: string | null;
      month: string;
      type_code: string;
      pump_mode: string;
      rows: string;
      volume_l: string;
    }>('select * from history.volume_report($1, $2)', [input.from, input.to]);
    return rows.map((r) => ({
      plantId: r.plant_id,
      month: r.month,
      typeCode: r.type_code,
      pumpMode: r.pump_mode,
      rows: Number(r.rows),
      volumeL: Number(r.volume_l),
    }));
  });
}
export async function historyClientVolume(
  appPool: pg.Pool,
  actor: SessionUser,
  clientId: string,
): Promise<{ month: string; rows: number; volumeL: number }[]> {
  await require(appPool, actor, 'history.read');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{ month: string; rows: string; volume_l: string }>(
      'select * from history.client_volume($1)',
      [clientId],
    );
    return rows.map((r) => ({ month: r.month, rows: Number(r.rows), volumeL: Number(r.volume_l) }));
  });
}
export interface ExpenseHistoryRow {
  plantId: string | null;
  month: string;
  category: string;
  rows: number;
  amountCentimes: number;
  quantityMl: number | null;
}
export async function historyExpenses(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string },
): Promise<ExpenseHistoryRow[]> {
  await require(appPool, actor, 'history.money');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{
      plant_id: string | null;
      month: string;
      category_code: string;
      rows: string;
      amount_centimes: string;
      quantity_ml: string | null;
    }>('select * from history.expense_report($1, $2)', [input.from, input.to]);
    return rows.map((r) => ({
      plantId: r.plant_id,
      month: r.month,
      category: r.category_code,
      rows: Number(r.rows),
      amountCentimes: Number(r.amount_centimes),
      quantityMl: r.quantity_ml === null ? null : Number(r.quantity_ml),
    }));
  });
}

/** The records a label can be mapped to (owner/app_admin): active clients, trucks and drivers, with the code and the name the screens show. */
export async function mappingTargets(appPool: pg.Pool, actor: SessionUser) {
  await require(appPool, actor, 'history.admin');
  return inRequest(appPool, actor, async (tx) => {
    const [clients, trucks, drivers, types, plants] = await Promise.all([
      tx.query<{ id: string; code: string; name: string }>(
        `select id, code, name from client where status = 'active' order by name limit 3000`,
      ),
      tx.query<{ id: string; code: string; plate: string }>(
        `select id, code, plate from truck where status = 'active' order by code`,
      ),
      tx.query<{ id: string; code: string; name: string }>(
        `select id, code, name from driver where status = 'active' order by code`,
      ),
      tx.query<{ code: string }>(`select code from concrete_type where status = 'active' order by code`),
      tx.query<{ id: string; code: string; name: string }>(`select id, code, name from plant order by code`),
    ]);
    return {
      clients: clients.rows,
      trucks: trucks.rows,
      drivers: drivers.rows,
      typeCodes: types.rows.map((r) => r.code),
      plants: plants.rows,
    };
  });
}
