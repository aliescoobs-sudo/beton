import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { type Effect, visibleEffects } from '../domain/effects';
import { invoiceDueDate, type InvoiceInput, parseInvoiceInput } from '../domain/invoice';
import { groupInvoiceLines, type InvoiceGroup, netToPay } from '../domain/invoice-groups';
import { type InvoicePayment, type InvoicePaymentState, invoicePayment } from '../domain/invoice-payment';
import { nextDocNumber } from './doc-number';

export type InvoiceError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'NOTHING_TO_INVOICE'
  | 'PAYMENT_TERM_TOO_LONG'
  | 'DUE_BEFORE_INVOICE'
  | 'TOO_MANY_ATTEMPTS'
  | 'CONFLICT';

/** What an invoice creation returns: identity and number, never an amount (office creates blind). */
export interface CreatedInvoice {
  id: string;
  number: string;
  /** What the invoice changed; the money facts only for a role that reads money. */
  effects: Effect[];
}

export const invoiceFailure = (error: unknown): InvoiceError => {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23514') {
    if (/already invoiced/.test(message ?? '')) return 'NOTHING_TO_INVOICE';
    if (/order is cancelled|unknown order|not a live load/.test(message ?? '')) return 'NOT_FOUND';
    if (/due_date/.test(message ?? '')) return 'PAYMENT_TERM_TOO_LONG';
    return 'INVALID';
  }
  if (code === '42501' && /too many failed attempts/.test(message ?? '')) return 'TOO_MANY_ATTEMPTS';
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  throw error;
};

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
    return await inRequest(appPool, actor, (tx) => insertInvoiceRows(tx, actor, v, due.value, deps.today));
  } catch (error) {
    return err(invoiceFailure(error));
  }
}

/**
 * The invoice, created entirely inside the database from the order code (`public.create_invoice`): the lines, the totals, the
 * client's name and ICE, the VAT rate, the FA number and the dates are all decided there, and only the number comes back
 * (DECISIONS 81, review of CP-L4). An unknown order, nothing left to invoice and loads that do not match give the same
 * answer; each failure is audited and ten in ten minutes lock the actor out. Shared by `createInvoice` and the pilot
 * scenario (system actor). A role that reads money then learns the invoice id and the receivable; office learns the number only.
 */
export async function insertInvoiceRows(
  tx: pg.PoolClient,
  actor: SessionUser,
  v: InvoiceInput,
  due: string,
  today: string,
): Promise<Result<CreatedInvoice, InvoiceError>> {
  // By the BLs of one client (the queue), or by the code of an order (office types what is printed): one door each.
  const made = v.orderCode
    ? await tx.query<{ number: string | null }>('select public.create_invoice($1, $2, $3, $4) as number', [
        v.orderCode,
        v.deliveryIds ?? null,
        due,
        today,
      ])
    : await tx.query<{ number: string | null }>(
        'select public.create_invoice_from_deliveries($1, $2, $3) as number',
        [v.deliveryIds, due, today],
      );
  const number = made.rows[0]?.number;
  if (!number) return err('NOTHING_TO_INVOICE');
  const effects: Effect[] = [{ kind: 'document', document: 'invoice', code: number }];
  let id = '';
  if (!actor.role || can(actor.role, 'invoices.read')) {
    const row = await tx.query<{ id: string; total: string; client_code: string }>(
      `select i.id, i.total_ttc_centimes::text as total, c.code as client_code
         from invoice i join client c on c.id = i.client_id where i.number = $1 and i.credit_note_of is null`,
      [number],
    );
    if (row.rows[0]) {
      id = row.rows[0].id;
      effects.push({
        kind: 'receivable',
        clientCode: row.rows[0].client_code,
        amountCentimes: Number(row.rows[0].total),
      });
    }
  }
  return ok({ id, number, effects: actor.role ? visibleEffects(effects, actor.role) : effects });
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
    return await inRequest(appPool, actor, (tx) =>
      insertCreditNoteRows(tx, actor, invoiceId, text, deps.today),
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return err('ALREADY_CREDITED');
    return err(invoiceFailure(error));
  }
}

/**
 * The rows of a credit note in the caller's transaction: refused when the invoice is itself a credit note or already
 * credited. Shared by `cancelInvoice` and the pilot scenario.
 */
export async function insertCreditNoteRows(
  tx: pg.PoolClient,
  actor: SessionUser,
  invoiceId: string,
  text: string,
  today: string,
): Promise<Result<CreatedInvoice, CancelInvoiceError>> {
  const original = await tx.query<{ credit_note_of: string | null; number: string }>(
    'select credit_note_of, number from invoice where id = $1',
    [invoiceId],
  );
  if (!original.rows[0]) return err('NOT_FOUND');
  if (original.rows[0].credit_note_of) return err('CANNOT_CREDIT_CREDIT_NOTE');
  if ((await tx.query('select 1 from invoice where credit_note_of = $1', [invoiceId])).rowCount)
    return err('ALREADY_CREDITED');
  const id = randomUUID();
  const number = await nextDocNumber(tx, 'FA', today);
  await tx.query(
    `insert into invoice (id, number, order_id, client_id, client_name, client_ice, invoice_date, issue_deadline,
                        due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes,
                        credit_note_of, reason, created_by)
   select $1, $2, order_id, client_id, client_name, client_ice, $3, issue_deadline, $3, vat_rate_bp,
          -total_ht_centimes, -total_vat_centimes, -total_ttc_centimes, id, $4, $5
     from invoice where id = $6`,
    [id, number, today, text, actor.id, invoiceId],
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
  const total = await tx.query<{ ttc: string; client_code: string }>(
    `select i.total_ttc_centimes::text as ttc, c.code as client_code from invoice i join client c on c.id = i.client_id where i.id = $1`,
    [id],
  );
  const effects: Effect[] = [
    { kind: 'document', document: 'credit_note', code: number },
    {
      kind: 'receivable',
      clientCode: total.rows[0]?.client_code ?? null,
      amountCentimes: Number(total.rows[0]?.ttc ?? 0),
    },
  ];
  return ok({ id, number, effects: visibleEffects(effects, actor.role) });
}

export interface InvoiceView {
  id: string;
  number: string;
  /** The orders it bills (one or several), from its lines. */
  orderCodes: string[];
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
  /** Derived from the order's covered plan items, oldest invoice first; null for a credit note or a cancelled invoice. */
  paymentState: InvoicePaymentState | null;
  paidCentimes: number;
}

/**
 * The payment state of every live invoice (not a credit note, not cancelled), derived by the database on every read, never
 * stored: what the client paid on each order covers the live invoices that bill it, oldest due date first
 * (`public.invoice_payment_state()`, owner and support only).
 */
export async function loadInvoicePayments(tx: pg.PoolClient): Promise<Map<string, InvoicePayment>> {
  const { rows } = await tx.query<{ invoice_id: string; total: string; paid: string }>(
    `select invoice_id, total_ttc_centimes::text as total, paid_centimes::text as paid from public.invoice_payment_state()`,
  );
  return new Map(rows.map((r) => [r.invoice_id, invoicePayment(Number(r.total), Number(r.paid))] as const));
}

/** Invoices and credit notes, newest first. Owner and support only (money). */
export async function listInvoices(appPool: pg.Pool, actor: SessionUser): Promise<InvoiceView[]> {
  await require(appPool, actor, 'invoices.read');
  const { rows, payments } = await inRequest(appPool, actor, async (tx) => {
    const payments = await loadInvoicePayments(tx);
    const result = await tx.query<{
      id: string;
      number: string;
      order_codes: string[];
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
      `select i.id, i.number,
              array(select distinct o.code from invoice_line l join delivery d on d.id = l.delivery_id
                      join sales_order o on o.id = d.order_id where l.invoice_id = i.id order by 1) as order_codes,
              i.client_id, i.client_name, i.client_ice,
              to_char(i.invoice_date, 'YYYY-MM-DD') as invoice_date, to_char(i.issue_deadline, 'YYYY-MM-DD') as issue_deadline,
              to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.vat_rate_bp, i.total_ht_centimes::text as total_ht,
              i.total_vat_centimes::text as total_vat, i.total_ttc_centimes::text as total_ttc, i.credit_note_of,
              exists (select 1 from invoice c where c.credit_note_of = i.id) as cancelled, i.reason
         from invoice i
        order by i.invoice_date desc, i.number desc`,
    );
    return { rows: result.rows, payments };
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    orderCodes: r.order_codes,
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
    paymentState: payments.get(r.id)?.state ?? null,
    paidCentimes: Number(payments.get(r.id)?.paidCentimes ?? 0),
  }));
}

export interface InvoiceDocument {
  invoice: InvoiceView;
  /** The number of the invoice a credit note cancels. */
  creditNoteOfNumber: string | null;
  lines: {
    seq: number;
    description: string;
    volumeL: number;
    unitPriceHtCentimes: number;
    lineHtCentimes: number;
  }[];
  /** The lines as the document shows them: one per product and price, the quantity summed, the BL numbers listed. */
  groups: InvoiceGroup[];
  /** "Acompte reçu": advances the client paid on these orders, applied when the invoice was made; 0 on a credit note. */
  advanceCentimes: number;
  /** "Net à payer": the total minus the advance. */
  netToPayCentimes: number;
  /** Whole days from the invoice date to the due date (the law 69-21 term printed on the document). */
  termDays: number;
}

/**
 * The invoice or credit note as it is printed: every figure comes from the stored rows, nothing is recomputed, so the
 * printed document equals the data (AC-LED-22). Owner and support (`invoices.read`).
 */
export async function getInvoiceDocument(
  appPool: pg.Pool,
  actor: SessionUser,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  await require(appPool, actor, 'invoices.read');
  try {
    const invoice = (await listInvoices(appPool, actor)).find((i) => i.id === invoiceId);
    if (!invoice) return null;
    return await inRequest(appPool, actor, async (tx): Promise<InvoiceDocument> => {
      const lines = await tx.query<{
        seq: number;
        description: string;
        volume_l: number;
        price: string;
        total: string;
        bl_no: string;
        type_code: string;
        type_label: string;
      }>(
        `select l.seq, l.description, l.volume_l, l.unit_price_ht_centimes::text as price, l.line_ht_centimes::text as total,
                d.bl_no, t.code as type_code, t.label as type_label
           from invoice_line l
           join delivery d on d.id = l.delivery_id
           join sales_order o on o.id = d.order_id
           join concrete_type t on t.id = o.concrete_type_id
          where l.invoice_id = $1 order by l.seq`,
        [invoiceId],
      );
      const advance = await tx.query<{ amount: string }>(
        `select coalesce(sum(amount_centimes), 0)::text as amount from invoice_advance where invoice_id = $1`,
        [invoiceId],
      );
      const advanceCentimes = Number(advance.rows[0]?.amount ?? 0);
      const meta = await tx.query<{ credited: string | null; term: number }>(
        `select (select o.number from invoice o where o.id = i.credit_note_of) as credited, (i.due_date - i.invoice_date) as term
           from invoice i where i.id = $1`,
        [invoiceId],
      );
      return {
        invoice,
        creditNoteOfNumber: meta.rows[0]?.credited ?? null,
        termDays: Number(meta.rows[0]?.term ?? 0),
        groups: groupInvoiceLines(
          lines.rows.map((l) => ({
            blNo: l.bl_no,
            typeCode: l.type_code,
            typeLabel: l.type_label,
            volumeL: l.volume_l,
            unitPriceHtCentimes: Number(l.price),
            lineHtCentimes: Number(l.total),
          })),
        ),
        advanceCentimes,
        netToPayCentimes: netToPay(invoice.totalTtcCentimes, advanceCentimes),
        lines: lines.rows.map((l) => ({
          seq: l.seq,
          description: l.description,
          volumeL: l.volume_l,
          unitPriceHtCentimes: Number(l.price),
          lineHtCentimes: Number(l.total),
        })),
      };
    });
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}
