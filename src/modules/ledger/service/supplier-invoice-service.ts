import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { type Effect, visibleEffects } from '../domain/effects';
import { isRealDate } from '../domain/dates';
import { invoiceDueDate } from '../domain/invoice';
import type { MatchFlag, MatchLine } from '../domain/supplier-invoice-match';
import {
  parseSupplierInvoiceInput,
  type SupplierInvoiceInput,
  type SupplierInvoiceState,
} from '../domain/supplier-invoice';

export type SupplierInvoiceError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'REFUSED'
  | 'PAYMENT_TERM_TOO_LONG'
  | 'DUE_BEFORE_INVOICE'
  | 'TOO_MANY_ATTEMPTS'
  | 'CONFLICT';

export interface CreatedSupplierInvoice {
  /** Empty for a role that cannot read it back (office enters blind: the code is all it learns). */
  id: string;
  code: string;
  effects: Effect[];
}

function failure(error: unknown): SupplierInvoiceError {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '42501' && /too many failed attempts/.test(message ?? '')) return 'TOO_MANY_ATTEMPTS';
  if (code === '23514') return 'REFUSED';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}

/**
 * The supplier's invoice for an order (AC-INT-13): the order by its printed code, the supplier's own number and date, the
 * lines as the supplier wrote them and, when given, the receipts it covers. Owner and office (office blind: the answer is our
 * code). The database links each line to the order's line of the same component, computes the totals and refuses a supplier
 * number already entered. Unknown order, a number already entered and bad lines are one answer, audited.
 */
export async function createSupplierInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<CreatedSupplierInvoice, SupplierInvoiceError>> {
  await require(appPool, actor, 'supplier_invoices.write');
  const parsed = parseSupplierInvoiceInput(input);
  if (!parsed.ok) return err('INVALID');
  const v: SupplierInvoiceInput = parsed.value;
  const due = invoiceDueDate(v.invoiceDate, v.dueDate);
  if (!due.ok) return err(due.error);
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<CreatedSupplierInvoice, SupplierInvoiceError>> => {
        const made = await tx.query<{ code: string | null }>(
          'select public.create_supplier_invoice($1, $2, $3, $4, $5::jsonb, $6, $7) as code',
          [
            v.purchaseCode,
            v.supplierInvoiceNo,
            v.invoiceDate,
            due.value,
            JSON.stringify(
              v.lines.map((l) => ({
                componentId: l.componentId ?? null,
                description: l.description ?? null,
                qtyMilli: l.qtyMilli,
                unitPriceHtCentimes: l.unitPriceHtCentimes,
              })),
            ),
            v.receiptIds ?? null,
            deps.today,
          ],
        );
        const code = made.rows[0]?.code;
        if (!code) return err('REFUSED');
        let id = '';
        if (can(actor.role, 'supplier_invoices.read')) {
          const row = await tx.query<{ id: string }>('select id from supplier_invoice where code = $1', [
            code,
          ]);
          id = row.rows[0]?.id ?? '';
        }
        const effects: Effect[] = [{ kind: 'document', document: 'supplier_invoice', code }];
        return ok({ id, code, effects: visibleEffects(effects, actor.role) });
      },
    );
  } catch (error) {
    return err(failure(error));
  }
}

export interface SupplierInvoiceView {
  id: string;
  code: string;
  purchaseId: string;
  purchaseCode: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  state: SupplierInvoiceState;
  receiptCount: number;
}

/** The supplier invoices, newest first, with their state (the last event). Owner and support (money). */
export async function listSupplierInvoices(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<SupplierInvoiceView[]> {
  await require(appPool, actor, 'supplier_invoices.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      code: string;
      purchase_id: string;
      purchase_code: string;
      supplier_id: string;
      supplier_name: string;
      no: string;
      invoice_date: string;
      due_date: string;
      ht: string;
      vat: string;
      ttc: string;
      state: SupplierInvoiceState;
      receipts: string;
    }>(
      `select s.id, s.code, s.purchase_id, p.code as purchase_code, s.supplier_id, f.name as supplier_name,
              s.supplier_invoice_no as no, to_char(s.invoice_date, 'YYYY-MM-DD') as invoice_date,
              to_char(s.due_date, 'YYYY-MM-DD') as due_date, s.total_ht_centimes::text as ht,
              s.total_vat_centimes::text as vat, s.total_ttc_centimes::text as ttc,
              (select e.event from supplier_invoice_event e where e.supplier_invoice_id = s.id order by e.seq desc limit 1) as state,
              (select count(*) from supplier_invoice_receipt r where r.supplier_invoice_id = s.id)::text as receipts
         from supplier_invoice s
         join purchase p on p.id = s.purchase_id
         join supplier f on f.id = s.supplier_id
        order by s.invoice_date desc, s.code desc`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    purchaseId: r.purchase_id,
    purchaseCode: r.purchase_code,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    supplierInvoiceNo: r.no,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    totalHtCentimes: Number(r.ht),
    totalVatCentimes: Number(r.vat),
    totalTtcCentimes: Number(r.ttc),
    state: r.state,
    receiptCount: Number(r.receipts),
  }));
}

export interface SupplierInvoiceDetail {
  invoice: SupplierInvoiceView;
  lines: {
    seq: number;
    description: string;
    purchaseLineSeq: number | null;
    qtyMilli: number;
    unitPriceHtCentimes: number;
    lineHtCentimes: number;
  }[];
  receipts: { id: string; receivedDate: string }[];
  events: { seq: number; event: SupplierInvoiceState; reason: string | null; at: string }[];
}

/** One supplier invoice with its lines, the receipts it covers and its events. Owner and support. */
export async function getSupplierInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<SupplierInvoiceDetail | null> {
  await require(appPool, actor, 'supplier_invoices.read');
  try {
    const invoice = (await listSupplierInvoices(appPool, actor)).find((i) => i.id === id);
    if (!invoice) return null;
    return await inRequest(appPool, actor, async (tx): Promise<SupplierInvoiceDetail> => {
      const lines = await tx.query<{
        seq: number;
        description: string;
        pline_seq: number | null;
        qty: string;
        price: string;
        total: string;
      }>(
        `select l.seq, l.description, pl.seq as pline_seq, l.qty_milli::text as qty,
                l.unit_price_ht_centimes::text as price, l.line_ht_centimes::text as total
           from supplier_invoice_line l left join purchase_line pl on pl.id = l.purchase_line_id
          where l.supplier_invoice_id = $1 order by l.seq`,
        [id],
      );
      const receipts = await tx.query<{ id: string; received_date: string }>(
        `select r.id, to_char(r.received_date, 'YYYY-MM-DD') as received_date
           from supplier_invoice_receipt x join purchase_receipt r on r.id = x.purchase_receipt_id
          where x.supplier_invoice_id = $1 order by r.received_date, r.id`,
        [id],
      );
      const events = await tx.query<{
        seq: number;
        event: SupplierInvoiceState;
        reason: string | null;
        at: string;
      }>(
        `select seq, event, reason, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
           from supplier_invoice_event where supplier_invoice_id = $1 order by seq`,
        [id],
      );
      return {
        invoice,
        lines: lines.rows.map((l) => ({
          seq: l.seq,
          description: l.description,
          purchaseLineSeq: l.pline_seq,
          qtyMilli: Number(l.qty),
          unitPriceHtCentimes: Number(l.price),
          lineHtCentimes: Number(l.total),
        })),
        receipts: receipts.rows.map((r) => ({ id: r.id, receivedDate: r.received_date })),
        events: events.rows.map((e) => ({ seq: e.seq, event: e.event, reason: e.reason, at: e.at })),
      };
    });
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}

const ids = z.object({ supplierInvoiceId: z.uuid() });
const reasonText = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(3).max(500));
const withReason = ids.extend({ reason: reasonText });
const planItem = z.object({
  method: z.enum(['cash', 'cheque', 'lcn', 'transfer', 'advance', 'installment']),
  dueDate: z.string().refine(isRealDate, 'date'),
  amountCentimes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const approveInput = ids.extend({ plan: z.array(planItem).min(1).max(24).nullish() });

type MatchRow = {
  seq: number;
  purchase_line_id: string | null;
  description: string;
  ordered_milli: string | null;
  po_price: string | null;
  received_milli: string;
  invoiced_milli: string;
  cumulative_milli: string;
  inv_price: string;
  flags: MatchFlag[];
};

/**
 * The three-way match of a supplier invoice, line by line: what was ordered, what was received through the receipts it covers,
 * what the supplier billed, and the gaps the database flags against the tolerances (parameters). Owner and support.
 */
export async function getSupplierInvoiceMatch(
  appPool: pg.Pool,
  actor: SessionUser,
  id: string,
): Promise<MatchLine[] | null> {
  await require(appPool, actor, 'supplier_invoices.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<MatchRow>(
        `select seq, purchase_line_id, description, ordered_milli::text, po_price::text, received_milli::text, invoiced_milli::text,
                cumulative_milli::text, inv_price::text, flags
           from public.supplier_invoice_match($1)`,
        [id],
      ),
    );
    return rows.map((r) => ({
      seq: r.seq,
      description: r.description,
      purchaseLineId: r.purchase_line_id,
      orderedMilli: r.ordered_milli === null ? null : Number(r.ordered_milli),
      orderedPriceCentimes: r.po_price === null ? null : Number(r.po_price),
      receivedMilli: Number(r.received_milli),
      invoicedMilli: Number(r.invoiced_milli),
      cumulativeMilli: Number(r.cumulative_milli),
      invoicedPriceCentimes: Number(r.inv_price),
      flags: r.flags,
    }));
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}

export type DecisionError =
  'INVALID' | 'NOT_FOUND' | 'NOT_PENDING' | 'GAPS_NOT_ACCEPTED' | 'NO_GAPS' | 'REFUSED' | 'CONFLICT';

/**
 * The owner accepts the gaps of a pending invoice, with a reason (AC-INT-14). Audited: the event row carries the reason, the
 * actor and the time. Only when the invoice has gaps and no decision was taken yet. The action layer asks for a fresh second factor.
 */
export async function acceptSupplierInvoiceGaps(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ accepted: true }, DecisionError>> {
  await require(appPool, actor, 'supplier_invoices.approve');
  const parsed = withReason.safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ ok: boolean }>('select public.accept_supplier_invoice_gaps($1, $2) as ok', [
        parsed.data.supplierInvoiceId,
        parsed.data.reason,
      ]),
    );
    return rows[0]?.ok ? ok({ accepted: true }) : err('NO_GAPS');
  } catch (error) {
    return err(decisionFailure(error));
  }
}

/** The owner rejects an invoice that is not approved yet, with a reason; its supplier number is free again. */
export async function rejectSupplierInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ rejected: true }, DecisionError>> {
  await require(appPool, actor, 'supplier_invoices.approve');
  const parsed = withReason.safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ ok: boolean }>('select public.reject_supplier_invoice($1, $2) as ok', [
        parsed.data.supplierInvoiceId,
        parsed.data.reason,
      ]),
    );
    return rows[0]?.ok ? ok({ rejected: true }) : err('NOT_PENDING');
  } catch (error) {
    return err(decisionFailure(error));
  }
}

/**
 * "Approve for payment": the owner only, after a fresh second factor (the action layer). Refused while gaps stand that the
 * owner has not accepted. It creates the payable from the invoice: the plan items (one transfer on the due date, or the plan
 * given, adding up to the invoice total), not from the order. The effects say what the payable is.
 */
export async function approveSupplierInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ effects: Effect[] }, DecisionError>> {
  await require(appPool, actor, 'supplier_invoices.approve');
  const parsed = approveInput.safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<{ effects: Effect[] }, DecisionError>> => {
        const approved = await tx.query<{ ok: boolean }>(
          'select public.approve_supplier_invoice($1, $2::jsonb) as ok',
          [parsed.data.supplierInvoiceId, parsed.data.plan ? JSON.stringify(parsed.data.plan) : null],
        );
        if (!approved.rows[0]?.ok) return err('NOT_PENDING');
        const row = await tx.query<{ ttc: string; supplier_code: string }>(
          `select s.total_ttc_centimes::text as ttc, f.code as supplier_code
           from supplier_invoice s join supplier f on f.id = s.supplier_id where s.id = $1`,
          [parsed.data.supplierInvoiceId],
        );
        return ok({
          effects: [
            {
              kind: 'payable',
              supplierCode: row.rows[0]?.supplier_code ?? null,
              amountCentimes: Number(row.rows[0]?.ttc ?? 0),
            },
          ],
        });
      },
    );
  } catch (error) {
    return err(decisionFailure(error));
  }
}

function decisionFailure(error: unknown): DecisionError {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23514' && /gaps the owner has not accepted/.test(message ?? '')) return 'GAPS_NOT_ACCEPTED';
  if (code === '23514') return 'REFUSED';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}
