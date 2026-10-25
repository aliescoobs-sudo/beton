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
  | 'EXCESS_NEEDS_OWNER';

export function receiptFailure(error: unknown): ReceiptError {
  const e = error as { code?: string; message?: string };
  const m = e.message ?? '';
  if (isUniqueViolation(error)) return 'ALREADY_RECEIVED';
  if (e.code === '23514') {
    if (/cancelled/.test(m)) return 'PURCHASE_CANCELLED';
    if (/movements are missing|lines or the stock movements/.test(m)) return 'NOTHING_TO_RECEIVE';
    if (/more than ordered/.test(m)) return 'EXCESS_NEEDS_OWNER';
    if (/whole number of base units/.test(m)) return 'FRACTIONAL_QUANTITY';
    if (/unknown purchase/.test(m)) return 'NOT_FOUND';
    return 'INVALID';
  }
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
      const { rows } = await tx.query<{ id: string }>('select public.record_receipt($1, $2) as id', [
        parsed.value.purchaseId,
        date,
      ]);
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
  nameFr: string;
  nameAr: string;
  unitLabel: string;
  qtyMilli: number;
}
  lineId: string;
export interface ReceivablePurchase {
  purchaseId: string;
  code: string;
  /** Ordered. */
  supplierCode: string;
  orderDate: string;
  lines: ReceivableLine[];
  /** Business date of the last receipt; null while nothing came in. */
  receivedOn: string | null;
  cancelled: boolean;
}

/** Purchases with stocked lines, newest first: what is still to receive and what came in. Quantities only (no price). */
export async function listReceivable(appPool: pg.Pool, actor: SessionUser): Promise<ReceivablePurchase[]> {
  await require(appPool, actor, 'receipts.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
  receipts: number;
  /** expected: nothing yet; partial: some lines short; complete: every line reached its ordered quantity. */
  status: 'expected' | 'partial' | 'complete';
    tx.query<{
      purchase_id: string;
      code: string;
      supplier_code: string;
      order_date: string;
      name_fr: string;
      name_ar: string;
      unit_label: string;
      qty_milli: string;
      is_reversed: boolean;
      received_on: string | null;
    }>(
      line_id: string;
      `select o.purchase_id, o.code, o.supplier_code, to_char(o.order_date, 'YYYY-MM-DD') as order_date, o.line_id, o.name_fr, o.name_ar,
              o.unit_label, o.qty_milli::text, o.is_reversed,
              (select to_char(r.received_date, 'YYYY-MM-DD') from purchase_receipt r where r.purchase_id = o.purchase_id) as received_on
         from purchase_line_ops o order by o.order_date desc, o.code desc, o.seq`,
      received_milli: string;
    ),
  );
      receipts: string;
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
        cancelled: r.is_reversed,
      };
      byPurchase.set(r.purchase_id, p);
    }
    p.lines.push({
      nameFr: r.name_fr,
      nameAr: r.name_ar,
      unitLabel: r.unit_label,
      qtyMilli: Number(r.qty_milli),
        receipts: Number(r.receipts),
        status: 'expected',
    });
  }
  return [...byPurchase.values()];
}
      lineId: r.line_id,
