import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { FileStore } from '@/lib/files/store';
import { type UploadError, validateUpload } from '@/lib/files/validate-upload';
import { err, ok, type Result } from '@/lib/result';
import { type MilliQty, toBase } from '@/lib/quantity';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  recordAuditEvent,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { type Effect, visibleEffects } from '@/modules/ledger';
import { parseReceiptInput } from '../domain/load-input';
import { stockEffects } from './effects';
import { opsParameter } from './ops-parameters';

export type ReceiptError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'ALREADY_RECEIVED'
  | 'PURCHASE_CANCELLED'
  | 'NOTHING_TO_RECEIVE'
  | 'FRACTIONAL_QUANTITY'
  | 'FUTURE_DATE'
  | 'EXCESS_NEEDS_OWNER'
  | 'PLANT_NOT_CONFIRMED'
  | 'PLANT_CONFIRMS_FIRST';

export function receiptFailure(error: unknown): ReceiptError {
  const e = error as { code?: string; message?: string };
  const m = e.message ?? '';
  if (isUniqueViolation(error)) return 'ALREADY_RECEIVED';
  if (e.code === '23514') {
    if (/cancelled/.test(m)) return 'PURCHASE_CANCELLED';
    if (/movements are missing|lines or the stock movements/.test(m)) return 'NOTHING_TO_RECEIVE';
    if (/more than ordered/.test(m)) return 'EXCESS_NEEDS_OWNER';
    if (/plant has not confirmed/.test(m)) return 'PLANT_NOT_CONFIRMED';
    if (/whole number of base units/.test(m)) return 'FRACTIONAL_QUANTITY';
    if (/unknown purchase/.test(m)) return 'NOT_FOUND';
    return 'INVALID';
  }
  if (e.code === '42501' && /plant confirms the arrival/.test(m)) return 'PLANT_CONFIRMS_FIRST';
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}

export interface ReceivedStock {
  receiptId: string;
  /** What the receipt changed: its document and the stock of every component. Filtered by role. */
  effects: Effect[];
}

/**
 * Receives a purchase (AC-OPS-03): its stocked lines go into the stock, once. The quantity of every line must be a whole
 * number of base units (2,5 t of cement is 2 500 000 g; 0,0005 t is refused, never rounded). Owner, partner, plant. The
 * result carries the receipt id only: the plant sees no price or total.
 */
export async function recordReceipt(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<ReceivedStock, ReceiptError>> {
  await require(appPool, actor, 'receipts.write');
  const parsed = parseReceiptInput(input);
  if (!parsed.ok) return err('INVALID');
  const date = parsed.value.receivedDate ?? deps.today;
  if (date > deps.today) return err('FUTURE_DATE');
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<ReceivedStock, ReceiptError>> => {
      const lines = await tx.query<{ line_id: string; qty_milli: string; factor: number }>(
        `select o.line_id, o.qty_milli::text, o.factor_to_base as factor from purchase_line_ops o where o.purchase_id = $1`,
        [parsed.value.purchaseId],
      );
      if (lines.rows.length === 0) return err('NOT_FOUND');
      const given = parsed.value.lines ?? null;
      for (const l of lines.rows) {
        // What is checked is what is received: the ordered quantity when everything is, else the quantities given.
        const qty = given ? given.find((g) => g.lineId === l.line_id)?.qtyMilli : Number(l.qty_milli);
        if (qty !== undefined && !toBase(qty as MilliQty, l.factor).ok) return err('FRACTIONAL_QUANTITY');
      }
      const { rows } = await tx.query<{ id: string }>(
        'select public.record_receipt_lines($1, $2, $3::jsonb, $4) as id',
        [
          parsed.value.purchaseId,
          date,
          given ? JSON.stringify(given.map((g) => ({ lineId: g.lineId, qtyMilli: g.qtyMilli }))) : null,
          parsed.value.confirmExcess === true,
        ],
      );
      const receiptId = rows[0]?.id as string;
      const code = await tx.query<{ code: string }>(
        'select code from purchase_line_ops where purchase_id = $1 limit 1',
        [parsed.value.purchaseId],
      );
      const effects: Effect[] = [
        { kind: 'document', document: 'receipt', code: code.rows[0]?.code ?? '' },
        ...(await stockEffects(tx, 'receipt', receiptId)),
      ];
      return ok({ receiptId, effects: visibleEffects(effects, actor.role) });
    });
  } catch (error) {
    return err(receiptFailure(error));
  }
}

export interface ReceivableLine {
  lineId: string;
  nameFr: string;
  nameAr: string;
  unitLabel: string;
  /** Ordered. */
  qtyMilli: number;
  /** Received so far, over all the receipts of the purchase. */
  receivedMilli: number;
}
export interface ReceivablePurchase {
  purchaseId: string;
  code: string;
  supplierCode: string;
  orderDate: string;
  lines: ReceivableLine[];
  /** Business date of the last receipt; null while nothing came in. */
  receivedOn: string | null;
  receipts: number;
  /** expected: nothing yet; partial: some lines short; complete: every line reached its ordered quantity. */
  status: 'expected' | 'partial' | 'complete';
  cancelled: boolean;
  /** The plant has confirmed an arrival that the office has not recorded yet (first step of the two-step receipt). */
  arrivalConfirmed: boolean;
}

/** Purchases with stocked lines, newest first: what is still to receive and what came in. Quantities only (no price). */
export async function listReceivable(appPool: pg.Pool, actor: SessionUser): Promise<ReceivablePurchase[]> {
  await require(appPool, actor, 'receipts.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      purchase_id: string;
      code: string;
      supplier_code: string;
      order_date: string;
      line_id: string;
      name_fr: string;
      name_ar: string;
      unit_label: string;
      qty_milli: string;
      received_milli: string;
      is_reversed: boolean;
      received_on: string | null;
      receipts: string;
      arrival_confirmed: boolean;
    }>(
      `select o.purchase_id, o.code, o.supplier_code, to_char(o.order_date, 'YYYY-MM-DD') as order_date, o.line_id, o.name_fr, o.name_ar,
              o.unit_label, o.qty_milli::text, o.is_reversed,
              coalesce((select sum(x.qty_milli) from purchase_receipt_line x where x.purchase_line_id = o.line_id), 0)::text as received_milli,
              (select to_char(max(r.received_date), 'YYYY-MM-DD') from purchase_receipt r where r.purchase_id = o.purchase_id) as received_on,
              (select count(*) from purchase_receipt r where r.purchase_id = o.purchase_id)::text as receipts,
              exists (select 1 from receipt_plant_confirmation c where c.purchase_id = o.purchase_id and c.receipt_id is null) as arrival_confirmed
         from purchase_line_ops o order by o.order_date desc, o.code desc, o.seq`,
    ),
  );
  const byPurchase = new Map<string, ReceivablePurchase>();
  for (const r of rows) {
    let p = byPurchase.get(r.purchase_id);
    if (!p) {
      p = {
        purchaseId: r.purchase_id,
        code: r.code,
        supplierCode: r.supplier_code,
        orderDate: r.order_date,
        lines: [],
        receivedOn: r.received_on,
        receipts: Number(r.receipts),
        status: 'expected',
        cancelled: r.is_reversed,
        arrivalConfirmed: r.arrival_confirmed,
      };
      byPurchase.set(r.purchase_id, p);
    }
    p.lines.push({
      lineId: r.line_id,
      nameFr: r.name_fr,
      nameAr: r.name_ar,
      unitLabel: r.unit_label,
      qtyMilli: Number(r.qty_milli),
      receivedMilli: Number(r.received_milli),
    });
  }
  for (const p of byPurchase.values()) {
    const reached = p.lines.every((l) => l.receivedMilli >= l.qtyMilli);
    p.status = reached ? 'complete' : p.receipts > 0 ? 'partial' : 'expected';
  }
  return [...byPurchase.values()];
}

export type ArrivalError = 'NOT_FOUND' | 'NOT_YOUR_PLANT' | 'ALREADY_CONFIRMED' | 'INVALID';

/** What the plant counted on one purchase line, in thousandths of the purchase unit (2,5 t = 2 500). */
export interface ArrivalLineInput {
  lineId: string;
  arrivedMilli: number;
  rejectedMilli?: number;
  /** May be used for production now, before the office documents the receipt. */
  available?: boolean;
}

const arrivalLinesSchema = z
  .array(
    z.object({
      lineId: z.uuid(),
      arrivedMilli: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      rejectedMilli: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      available: z.boolean().optional(),
    }),
  )
  .max(50);

/**
 * First step of the two-step receipt (D133, §16.7): the plant confirms that the delivery arrived, optionally with what it counted
 * per line (arrived, refused, usable now). The office confirms with the supplier and enters the details (`recordReceipt`), which
 * uses this confirmation. Owner, partner and the plant. No price is written or returned.
 */
export async function confirmArrivalAtPlant(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { purchaseId: string; note?: string | null; lines?: ArrivalLineInput[] },
): Promise<Result<{ confirmationId: string }, ArrivalError>> {
  await require(appPool, actor, 'receipts.confirm_arrival');
  const note = input.note?.trim() || null;
  if (note !== null && note.length > 300) return err('INVALID');
  const lines = arrivalLinesSchema.safeParse(input.lines ?? []);
  if (!lines.success) return err('INVALID');
  for (const l of lines.data) if ((l.rejectedMilli ?? 0) > l.arrivedMilli) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      lines.data.length === 0
        ? tx.query<{ id: string }>('select public.confirm_receipt_at_plant($1, $2) as id', [
            input.purchaseId,
            note,
          ])
        : tx.query<{ id: string }>('select public.confirm_receipt_at_plant_lines($1, $2, $3::jsonb) as id', [
            input.purchaseId,
            note,
            JSON.stringify(
              lines.data.map((l) => ({
                line: l.lineId,
                arrived: l.arrivedMilli,
                rejected: l.rejectedMilli ?? 0,
                available: l.available ?? false,
              })),
            ),
          ]),
    );
    return ok({ confirmationId: rows[0]?.id as string });
  } catch (error) {
    const e = error as { code?: string };
    if (isUniqueViolation(error)) return err('ALREADY_CONFIRMED');
    if (e.code === '42501') return err('NOT_YOUR_PLANT');
    if (e.code === '23514' || isMalformedId(error)) return err('INVALID');
    throw error;
  }
}

export type ReceiptState = 'arrived' | 'available' | 'documented';

export interface ReceiptStateLine {
  lineId: string;
  nameFr: string;
  nameAr: string;
  unitLabel: string;
  orderedMilli: number;
  arrivedMilli: number;
  rejectedMilli: number;
  available: boolean;
  /** Less than ordered reached the plant (after what was refused): the rest is still to come. */
  partial: boolean;
}
export interface ReceiptStateView {
  confirmationId: string;
  purchaseId: string;
  purchaseCode: string;
  confirmedAt: string;
  state: ReceiptState;
  documented: boolean;
  note: string | null;
  files: number;
  lines: ReceiptStateLine[];
}

/** Arrivals of the last `days` days with their state per line (arrived, available for production, documented). No price. */
export async function listReceiptStates(
  appPool: pg.Pool,
  actor: SessionUser,
  opts: { since: string },
): Promise<ReceiptStateView[]> {
  await require(appPool, actor, 'receipts.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      confirmation_id: string;
      purchase_id: string;
      purchase_code: string;
      confirmed_at: Date;
      state: ReceiptState;
      documented: boolean;
      note: string | null;
      files: number;
      line_id: string;
      name_fr: string;
      name_ar: string;
      unit_label: string;
      ordered_milli: string;
      arrived_milli: string;
      rejected_milli: string;
      available: boolean;
    }>('select * from public.receipt_states($1)', [opts.since]),
  );
  const out = new Map<string, ReceiptStateView>();
  for (const r of rows) {
    let v = out.get(r.confirmation_id);
    if (!v) {
      v = {
        confirmationId: r.confirmation_id,
        purchaseId: r.purchase_id,
        purchaseCode: r.purchase_code,
        confirmedAt: r.confirmed_at.toISOString(),
        state: r.state,
        documented: r.documented,
        note: r.note,
        files: r.files,
        lines: [],
      };
      out.set(r.confirmation_id, v);
    }
    const arrived = Number(r.arrived_milli);
    const rejected = Number(r.rejected_milli);
    v.lines.push({
      lineId: r.line_id,
      nameFr: r.name_fr,
      nameAr: r.name_ar,
      unitLabel: r.unit_label,
      orderedMilli: Number(r.ordered_milli),
      arrivedMilli: arrived,
      rejectedMilli: rejected,
      available: r.available,
      partial: arrived > 0 && arrived - rejected < Number(r.ordered_milli),
    });
  }
  return [...out.values()];
}

export type ArrivalFileError = UploadError | 'NOT_FOUND' | 'ALREADY_DOCUMENTED' | 'TOO_MANY' | 'INVALID';

/** The weighbridge ticket or delivery note of an arrival: checked, metadata stripped, sealed; the row first, so a refusal leaves nothing. */
export async function attachArrivalFile(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { confirmationId: string; kind: 'weighbridge_ticket' | 'delivery_note' },
  upload: { declaredType: string; bytes: Uint8Array },
  deps: { store: FileStore },
): Promise<Result<{ id: string }, ArrivalFileError>> {
  await require(appPool, actor, 'receipts.confirm_arrival');
  const p = z
    .object({ confirmationId: z.uuid(), kind: z.enum(['weighbridge_ticket', 'delivery_note']) })
    .safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<{ id: string }, ArrivalFileError>> => {
      const checked = validateUpload({
        declaredType: upload.declaredType,
        bytes: upload.bytes,
        maxBytes: await opsParameter(tx, 'upload_max_bytes'),
      });
      if (!checked.ok) return err(checked.error);
      const id = randomUUID();
      await tx.query(
        `insert into receipt_arrival_file (id, confirmation_id, kind, content_type, size_bytes, sha256, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          p.data.confirmationId,
          p.data.kind,
          checked.value.type,
          checked.value.bytes.length,
          createHash('sha256').update(checked.value.bytes).digest('hex'),
          actor.id,
        ],
      );
      await deps.store.put(id, checked.value.bytes);
      return ok({ id });
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const m = e.message ?? '';
    if (/already documented/.test(m)) return err('ALREADY_DOCUMENTED');
    if (/at most five/.test(m)) return err('TOO_MANY');
    if (e.code === '23503' || e.code === '23514' || e.code === '42501' || isMalformedId(error))
      return err('NOT_FOUND');
    throw error;
  }
}

export interface ArrivalFileView {
  id: string;
  confirmationId: string;
  kind: 'weighbridge_ticket' | 'delivery_note';
  contentType: string;
}

export async function listArrivalFiles(
  appPool: pg.Pool,
  actor: SessionUser,
  confirmationIds: string[],
): Promise<ArrivalFileView[]> {
  await require(appPool, actor, 'receipts.read');
  if (confirmationIds.length === 0) return [];
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ id: string; confirmation_id: string; kind: ArrivalFileView['kind']; content_type: string }>(
      `select id, confirmation_id, kind, content_type from receipt_arrival_file where confirmation_id = any($1::uuid[]) order by created_at`,
      [confirmationIds],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    confirmationId: r.confirmation_id,
    kind: r.kind,
    contentType: r.content_type,
  }));
}

/** For download: through the caller's own RLS, the view audited, a file that no longer matches its hash refused. */
export async function openArrivalFile(
  appPool: pg.Pool,
  actor: SessionUser,
  fileId: string,
  deps: { store: FileStore },
): Promise<Result<{ contentType: string; bytes: Buffer; kind: string }, 'NOT_FOUND' | 'CORRUPT'>> {
  await require(appPool, actor, 'receipts.read');
  if (!z.uuid().safeParse(fileId).success) return err('NOT_FOUND');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      content_type: string;
      sha256: string;
      kind: string;
      code: string;
    }>(
      `select f.id, f.content_type, f.sha256, f.kind, p.code
         from receipt_arrival_file f join receipt_plant_confirmation c on c.id = f.confirmation_id
         join purchase_line_ops p on p.purchase_id = c.purchase_id where f.id = $1 limit 1`,
      [fileId],
    );
    const row = rows[0];
    if (!row) return err('NOT_FOUND');
    await recordAuditEvent(tx, { action: 'view', table: `file:receipt_arrival:${row.code}`, rowId: row.id });
    const bytes = await deps.store.get(row.id).catch(() => null);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) return err('CORRUPT');
    return ok({ contentType: row.content_type, bytes, kind: row.kind });
  });
}
