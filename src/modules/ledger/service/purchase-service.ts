import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { centimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { needsOldEntryPermission } from '../domain/reversal';
import { type PlanItemInput, splitPlan } from '../domain/plan';
import { computePurchaseTotals, parsePurchaseInput, purchaseDueDate } from '../domain/purchase';
import { nextDocNumber } from './doc-number';
import { ledgerParameter } from './order-service';

export type PurchaseError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'SUPPLIER_ARCHIVED'
  | 'PAYMENT_TERM_TOO_LONG'
  | 'DUE_BEFORE_ORDER'
  | 'PLAN_INVALID'
  | 'CONFLICT';

/** What a purchase creation returns: the identity and the code, never an amount (office enters blind, DECISIONS 81). */
export interface CreatedPurchase {
  id: string;
  code: string;
}

export const purchaseFailure = (error: unknown): PurchaseError => {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23514') {
    if (/supplier is not active/.test(message ?? '')) return 'SUPPLIER_ARCHIVED';
    if (/payment plan|add up|adds up/.test(message ?? '')) return 'PLAN_INVALID';
    if (/due_date/.test(message ?? '')) return 'PAYMENT_TERM_TOO_LONG';
    return 'INVALID';
  }
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  throw error;
};

/**
 * Creates a purchase with its lines and its payment plan in one transaction (AC-LED-16, AC-LED-02, AC-LED-18). The VAT
 * rate is the parameter in force and is stored on the purchase; totals come from the domain function; the due date is
 * the supplier's invoice date (else the order date) + 60 days unless given, never more than 120 (law 69-21).
 */
export async function createPurchase(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<CreatedPurchase, PurchaseError>> {
  await require(appPool, actor, 'purchases.write');
  const parsed = parsePurchaseInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const due = purchaseDueDate(deps.today, v.supplierInvoiceDate, v.dueDate);
  if (!due.ok) return err(due.error);

  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<CreatedPurchase, PurchaseError>> => {
      const supplier = await tx.query<{ status: string }>('select status from supplier where id = $1', [
        v.supplierId,
      ]);
      if (!supplier.rows[0]) return err('NOT_FOUND');
      if (supplier.rows[0].status !== 'active') return err('SUPPLIER_ARCHIVED');

      const vatRateBp = await ledgerParameter(tx, 'vat_rate_bp');
      const totals = computePurchaseTotals(v.lines, vatRateBp);
      if (!totals.ok) return err('INVALID');

      const items: PlanItemInput[] = v.plan
        ? v.plan.map((i) => ({
            method: i.method,
            dueDate: i.dueDate,
            share:
              i.percentBp !== undefined
                ? { percentBp: i.percentBp }
                : { amount: centimes(i.amountCentimes as number) },
          }))
        : [{ method: 'transfer', dueDate: due.value, share: { percentBp: 10_000 } }];
      const plan = splitPlan(totals.value.totalTtc, items);
      if (!plan.ok) return err('PLAN_INVALID');

      const id = randomUUID();
      const code = await nextDocNumber(tx, 'ACH', deps.today);
      // No RETURNING: office has no SELECT policy on the table (blind entry).
      await tx.query(
        `insert into purchase (id, code, supplier_id, order_date, supplier_invoice_no, supplier_invoice_date, due_date,
                               vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          code,
          v.supplierId,
          deps.today,
          v.supplierInvoiceNo ?? null,
          v.supplierInvoiceDate ?? null,
          due.value,
          vatRateBp,
          totals.value.totalHt,
          totals.value.totalVat,
          totals.value.totalTtc,
          actor.id,
        ],
      );
      for (const [n, line] of v.lines.entries()) {
        await tx.query(
          `insert into purchase_line (id, purchase_id, seq, component_id, purchase_unit_id, description, qty_milli,
                                      unit_price_ht_centimes, line_ht_centimes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            id,
            n + 1,
            'componentId' in line ? line.componentId : null,
            'purchaseUnitId' in line ? line.purchaseUnitId : null,
            'description' in line ? line.description : null,
            line.qtyMilli,
            line.unitPriceHtCentimes,
            totals.value.lineHt[n],
            actor.id,
          ],
        );
      }
      for (const [n, item] of plan.value.entries()) {
        await tx.query(
          `insert into purchase_plan_item (id, purchase_id, seq, method, due_date, amount_centimes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), id, n + 1, item.method, item.dueDate, item.amount, actor.id],
        );
      }
      return ok({ id, code });
    });
  } catch (error) {
    return err(purchaseFailure(error));
  }
}

export type CancelPurchaseError =
  PurchaseError | 'ALREADY_REVERSED' | 'CANNOT_REVERSE_REVERSAL' | 'WINDOW_CLOSED' | 'REASON_REQUIRED';

/**
 * Cancels a purchase with a reversing entry (R12, AC-LED-03): a new `purchase` row that negates the original and negated
 * plan items, with a mandatory reason, in one transaction; the original is never touched. The owner's (DECISIONS 81).
 */
export async function cancelPurchase(
  appPool: pg.Pool,
  actor: SessionUser,
  purchaseId: string,
  reason: unknown,
  deps: { today: string },
): Promise<Result<CreatedPurchase, CancelPurchaseError>> {
  await require(appPool, actor, 'ledger.reverse');
  const text = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
  if (text.length < 3 || text.length > 500) return err('REASON_REQUIRED');
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<CreatedPurchase, CancelPurchaseError>> => {
        const original = await tx.query<{ reverses_id: string | null; order_date: string; code: string }>(
          `select reverses_id, to_char(order_date, 'YYYY-MM-DD') as order_date, code from purchase where id = $1`,
          [purchaseId],
        );
        if (!original.rows[0]) return err('NOT_FOUND');
        if (original.rows[0].reverses_id) return err('CANNOT_REVERSE_REVERSAL');
        if ((await tx.query('select 1 from purchase where reverses_id = $1', [purchaseId])).rowCount)
          return err('ALREADY_REVERSED');
        const windowDays = await ledgerParameter(tx, 'reversal_window_days');
        if (
          needsOldEntryPermission(original.rows[0].order_date, deps.today, windowDays) &&
          !can(actor.role, 'ledger.reverse_old')
        )
          return err('WINDOW_CLOSED');

        const id = randomUUID();
        const code = await nextDocNumber(tx, 'ACH', deps.today);
        await tx.query(
          `insert into purchase (id, code, supplier_id, order_date, supplier_invoice_no, supplier_invoice_date, due_date,
                               vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reverses_id, reason, created_by)
         select $1, $2, supplier_id, order_date, supplier_invoice_no, supplier_invoice_date, due_date, vat_rate_bp,
                -total_ht_centimes, -total_vat_centimes, -total_ttc_centimes, id, $3, $4
           from purchase where id = $5`,
          [id, code, text, actor.id, purchaseId],
        );
        await tx.query(
          `insert into purchase_plan_item (id, purchase_id, seq, method, due_date, amount_centimes, reverses_id, created_by)
         select gen_random_uuid(), $1, seq, method, due_date, -amount_centimes, id, $2
           from purchase_plan_item where purchase_id = $3`,
          [id, actor.id, purchaseId],
        );
        await tx.query(
          `select audit.record('reverse', 'purchase', $1, jsonb_build_object('reverses', $2::text, 'code', $3::text),
                             jsonb_build_object('reversal_code', $4::text), $5)`,
          [id, purchaseId, original.rows[0].code, code, text],
        );
        return ok({ id, code });
      },
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return err('ALREADY_REVERSED');
    return err(purchaseFailure(error));
  }
}

export interface PurchaseView {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string;
  orderDate: string;
  supplierInvoiceNo: string | null;
  dueDate: string;
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  /** Cancelled by a later reversal row; the reversal rows themselves are not listed. */
  reversed: boolean;
  received: boolean;
}

/** The purchases with their totals, newest first. Owner and support only (money). */
export async function listPurchases(appPool: pg.Pool, actor: SessionUser): Promise<PurchaseView[]> {
  await require(appPool, actor, 'purchases.read_money');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      code: string;
      supplier_id: string;
      supplier_name: string;
      order_date: string;
      supplier_invoice_no: string | null;
      due_date: string;
      total_ht: string;
      total_vat: string;
      total_ttc: string;
      reversed: boolean;
      received: boolean;
    }>(
      `select p.id, p.code, p.supplier_id, s.name as supplier_name, to_char(p.order_date, 'YYYY-MM-DD') as order_date,
              p.supplier_invoice_no, to_char(p.due_date, 'YYYY-MM-DD') as due_date,
              p.total_ht_centimes::text as total_ht, p.total_vat_centimes::text as total_vat,
              p.total_ttc_centimes::text as total_ttc,
              exists (select 1 from purchase r where r.reverses_id = p.id) as reversed,
              ${RECEIVED_SQL} as received
         from purchase p join supplier s on s.id = p.supplier_id
        where p.reverses_id is null
        order by p.order_date desc, p.code desc`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    orderDate: r.order_date,
    supplierInvoiceNo: r.supplier_invoice_no,
    dueDate: r.due_date,
    totalHtCentimes: Number(r.total_ht),
    totalVatCentimes: Number(r.total_vat),
    totalTtcCentimes: Number(r.total_ttc),
    reversed: r.reversed,
    received: r.received,
  }));
}

/** SQL fragment: the purchase has its receipt (L21). Defined here so the list and the receipt view agree. */
export const RECEIVED_SQL = `exists (select 1 from purchase_receipt r where r.purchase_id = p.id)`;
