import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import {
  computeInvoiceTotals,
  invoiceDueDate,
  invoiceIssueDeadline,
  parseInvoiceInput,
} from '../domain/invoice';
import { nextDocNumber } from './doc-number';

export type InvoiceError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'NOTHING_TO_INVOICE'
  | 'PAYMENT_TERM_TOO_LONG'
  | 'DUE_BEFORE_INVOICE'
  | 'CONFLICT';

/** What an invoice creation returns: identity and number, never an amount (office creates blind). */
export interface CreatedInvoice {
  id: string;
  number: string;
}

export const invoiceFailure = (error: unknown): InvoiceError => {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23514') {
    if (/already invoiced/.test(message ?? '')) return 'NOTHING_TO_INVOICE';
    if (/order is cancelled|unknown order|not a live load/.test(message ?? '')) return 'NOT_FOUND';
    if (/due_date/.test(message ?? '')) return 'PAYMENT_TERM_TOO_LONG';
    return 'INVALID';
  }
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  throw error;
};

interface SourceRow {
  order_code: string;
  type_code: string;
  client_id: string;
  client_name: string;
  client_ice: string | null;
  unit_price_ht_centimes: string;
  vat_rate_bp: number;
  delivery_id: string;
  bl_no: string;
  load_date: string;
  volume_l: number;
}

/**
 * Invoices the loads of an order (AC-LED-08, 09, 15): one line per load at the order's unit price, the client's name and
 * ICE and the order's VAT rate copied onto the invoice, the number FA-YYYY-nnnnn from the gapless counter, the due date
 * invoice date + 60 days unless given (never more than 120), the issue deadline the last day of the delivery month.
 * A load is invoiced once. Owner and office (blind: the result carries the number only).
 */
export async function createInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<CreatedInvoice, InvoiceError>> {
  await require(appPool, actor, 'invoices.write');
  const parsed = parseInvoiceInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const due = invoiceDueDate(deps.today, v.dueDate);
  if (!due.ok) return err(due.error);

  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<CreatedInvoice, InvoiceError>> => {
      const source = await tx.query<SourceRow>(
        `select order_code, type_code, client_id, client_name, client_ice, unit_price_ht_centimes::text, vat_rate_bp,
                delivery_id, bl_no, to_char(load_date, 'YYYY-MM-DD') as load_date, volume_l
           from public.invoice_source($1)`,
        [v.orderId],
      );
      if (source.rows.length === 0) return err('NOTHING_TO_INVOICE');
      const chosen = v.deliveryIds
        ? source.rows.filter((r) => v.deliveryIds?.includes(r.delivery_id))
        : source.rows;
      if (v.deliveryIds && chosen.length !== new Set(v.deliveryIds).size) return err('NOT_FOUND');
      const head = chosen[0] as SourceRow;
      const lines = chosen.map((r) => ({
        volumeL: r.volume_l,
        unitPriceHtCentimes: Number(r.unit_price_ht_centimes),
      }));
      const totals = computeInvoiceTotals(lines, head.vat_rate_bp);
      if (!totals.ok) return err('INVALID');
      const lastLoad = chosen.reduce((m, r) => (r.load_date > m ? r.load_date : m), head.load_date);

      const id = randomUUID();
      const number = await nextDocNumber(tx, 'FA', deps.today);
      // No RETURNING: office has no SELECT policy on the table (blind entry).
      await tx.query(
        `insert into invoice (id, number, order_id, client_id, client_name, client_ice, invoice_date, issue_deadline,
                              due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          number,
          v.orderId,
          head.client_id,
          head.client_name,
          head.client_ice,
          deps.today,
          invoiceIssueDeadline(lastLoad),
          due.value,
          head.vat_rate_bp,
          totals.value.totalHt,
          totals.value.totalVat,
          totals.value.totalTtc,
          actor.id,
        ],
      );
      for (const [n, r] of chosen.entries()) {
        await tx.query(
          `insert into invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes,
                                     line_ht_centimes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            randomUUID(),
            id,
            n + 1,
            r.delivery_id,
            `Béton ${r.type_code} — BL ${r.bl_no} du ${r.load_date}`,
            r.volume_l,
            r.unit_price_ht_centimes,
            totals.value.lineHt[n],
            actor.id,
          ],
        );
      }
      return ok({ id, number });
    });
  } catch (error) {
    return err(invoiceFailure(error));
  }
}

export type CancelInvoiceError =
  InvoiceError | 'ALREADY_CREDITED' | 'CANNOT_CREDIT_CREDIT_NOTE' | 'REASON_REQUIRED';

/**
 * Cancels an invoice with a credit note (AC-LED-08, AC-LED-03): a new invoice row with its own FA number that negates the
 * invoice (lines included), with a mandatory reason. The invoice keeps its number and is never edited. Owner only.
 */
export async function cancelInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  invoiceId: string,
  reason: unknown,
  deps: { today: string },
): Promise<Result<CreatedInvoice, CancelInvoiceError>> {
  await require(appPool, actor, 'ledger.reverse');
  const text = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
  if (text.length < 3 || text.length > 500) return err('REASON_REQUIRED');
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<CreatedInvoice, CancelInvoiceError>> => {
        const original = await tx.query<{ credit_note_of: string | null; number: string }>(
          'select credit_note_of, number from invoice where id = $1',
          [invoiceId],
        );
        if (!original.rows[0]) return err('NOT_FOUND');
        if (original.rows[0].credit_note_of) return err('CANNOT_CREDIT_CREDIT_NOTE');
        if ((await tx.query('select 1 from invoice where credit_note_of = $1', [invoiceId])).rowCount)
          return err('ALREADY_CREDITED');
        const id = randomUUID();
        const number = await nextDocNumber(tx, 'FA', deps.today);
        await tx.query(
          `insert into invoice (id, number, order_id, client_id, client_name, client_ice, invoice_date, issue_deadline,
                              due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes,
                              credit_note_of, reason, created_by)
         select $1, $2, order_id, client_id, client_name, client_ice, $3, issue_deadline, $3, vat_rate_bp,
                -total_ht_centimes, -total_vat_centimes, -total_ttc_centimes, id, $4, $5
           from invoice where id = $6`,
          [id, number, deps.today, text, actor.id, invoiceId],
        );
        await tx.query(
          `insert into invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes, line_ht_centimes, created_by)
         select gen_random_uuid(), $1, seq, delivery_id, description, -volume_l, unit_price_ht_centimes, -line_ht_centimes, $2
           from invoice_line where invoice_id = $3`,
          [id, actor.id, invoiceId],
        );
        await tx.query(
          `select audit.record('reverse', 'invoice', $1, jsonb_build_object('credits', $2::text, 'number', $3::text),
                             jsonb_build_object('credit_note', $4::text), $5)`,
          [id, invoiceId, original.rows[0].number, number, text],
        );
        return ok({ id, number });
      },
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return err('ALREADY_CREDITED');
    return err(invoiceFailure(error));
  }
}

export interface InvoiceView {
  id: string;
  number: string;
  orderCode: string;
  clientId: string;
  clientName: string;
  clientIce: string | null;
  invoiceDate: string;
  issueDeadline: string;
  dueDate: string;
  vatRateBp: number;
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  /** The invoice this credit note cancels, else null. */
  creditNoteOf: string | null;
  /** An invoice that a credit note cancels. */
  cancelled: boolean;
  reason: string | null;
}

/** Invoices and credit notes, newest first. Owner and support only (money). */
export async function listInvoices(appPool: pg.Pool, actor: SessionUser): Promise<InvoiceView[]> {
  await require(appPool, actor, 'invoices.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      number: string;
      order_code: string;
      client_id: string;
      client_name: string;
      client_ice: string | null;
      invoice_date: string;
      issue_deadline: string;
      due_date: string;
      vat_rate_bp: number;
      total_ht: string;
      total_vat: string;
      total_ttc: string;
      credit_note_of: string | null;
      cancelled: boolean;
      reason: string | null;
    }>(
      `select i.id, i.number, o.code as order_code, i.client_id, i.client_name, i.client_ice,
              to_char(i.invoice_date, 'YYYY-MM-DD') as invoice_date, to_char(i.issue_deadline, 'YYYY-MM-DD') as issue_deadline,
              to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.vat_rate_bp, i.total_ht_centimes::text as total_ht,
              i.total_vat_centimes::text as total_vat, i.total_ttc_centimes::text as total_ttc, i.credit_note_of,
              exists (select 1 from invoice c where c.credit_note_of = i.id) as cancelled, i.reason
         from invoice i join sales_order o on o.id = i.order_id
        order by i.invoice_date desc, i.number desc`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    orderCode: r.order_code,
    clientId: r.client_id,
    clientName: r.client_name,
    clientIce: r.client_ice,
    invoiceDate: r.invoice_date,
    issueDeadline: r.issue_deadline,
    dueDate: r.due_date,
    vatRateBp: r.vat_rate_bp,
    totalHtCentimes: Number(r.total_ht),
    totalVatCentimes: Number(r.total_vat),
    totalTtcCentimes: Number(r.total_ttc),
    creditNoteOf: r.credit_note_of,
    cancelled: r.cancelled,
    reason: r.reason,
  }));
}
