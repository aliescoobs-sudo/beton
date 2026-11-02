import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { type MilliQty, toBase } from '@/lib/quantity';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { type Effect, visibleEffects } from '@/modules/ledger';
import { parseReceiptInput } from '../domain/load-input';
import { stockEffects } from './effects';

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

/**
 * First step of a receipt (REQUIREMENTS-V1 §6, D133): the plant confirms that a delivery arrived. Nothing enters the stock
 * yet; the office confirms with the supplier and enters the details (`recordReceipt`), which uses this confirmation.
 * Owner, partner and the plant. No quantity and no price is written or returned.
 */
export async function confirmArrivalAtPlant(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { purchaseId: string; note?: string | null },
): Promise<Result<{ confirmationId: string }, ArrivalError>> {
  await require(appPool, actor, 'receipts.confirm_arrival');
  const note = input.note?.trim() || null;
  if (note !== null && note.length > 300) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.confirm_receipt_at_plant($1, $2) as id', [
        input.purchaseId,
        note,
      ]),
    );
    return ok({ confirmationId: rows[0]?.id as string });
  } catch (error) {
    const e = error as { code?: string };
    if (isUniqueViolation(error)) return err('ALREADY_CONFIRMED');
    if (e.code === '42501') return err('NOT_YOUR_PLANT');
    if (e.code === '23514' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
