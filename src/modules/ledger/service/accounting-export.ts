import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import {
  INVOICE_ITEM,
  inRequest,
  require,
  seesBalances,
  type SessionUser,
} from '@/modules/platform-security';
import { isRealDate } from '../domain/dates';
import {
  type AgeingItem,
  ageingCsv,
  type MovementRow,
  type PaymentRow,
  paymentsCsv,
  type PurchaseRow,
  purchasesJournalCsv,
  reconcile,
  type ReconciliationError,
  type SalesRow,
  salesJournalCsv,
} from '../domain/journals';

export const EXPORT_FILES = ['sales', 'purchases', 'payments', 'ageing'] as const;
export type ExportFile = (typeof EXPORT_FILES)[number];

/**
 * F09: the accountant gets the sales journal (invoices and credit notes with their amounts, which the role reads) and nothing
 * that is a balance or a treasury figure: no payments, no cash or bank movements, no ageing. The role has no read of the purchase
 * tables, so this legacy export holds no purchases journal for it; its purchases journal is the restricted one of the finance
 * module (`finance.accounting_journal`, when the module is on). The other roles of `accounting.export` get the four files.
 */
export const exportFilesFor = (role: SessionUser['role']): readonly ExportFile[] =>
  seesBalances(role, INVOICE_ITEM) ? EXPORT_FILES : EXPORT_FILES.filter((f) => f === 'sales');

export interface AccountingExport {
  from: string;
  to: string;
  files: Record<ExportFile, string>;
  summary: {
    invoices: number;
    purchases: number;
    payments: number;
    movements: number;
    salesTtcCentimes: number;
    purchasesTtcCentimes: number;
  };
}

export type ExportError = 'INVALID_PERIOD' | ReconciliationError;

/**
 * The accountant's files for a period (AC-LED-24): sales journal (invoices and credit notes), purchases journal, payments
 * with the cash and bank movements, and the receivables and payables ageing at the end of the period. The journals are
 * checked against the invoice lines before anything is returned: an export that does not tie out is refused. Owner and
 * support only; the caller audits every download.
 */
export async function buildAccountingExport(
  appPool: pg.Pool,
  actor: SessionUser,
  period: { from: string; to: string },
): Promise<Result<AccountingExport, ExportError>> {
  await require(appPool, actor, 'accounting.export');
  const { from, to } = period;
  if (!isRealDate(from) || !isRealDate(to) || from > to) return err('INVALID_PERIOD');
  return inRequest(appPool, actor, async (tx): Promise<Result<AccountingExport, ExportError>> => {
    const sales = (
      await tx.query<{
        number: string;
        date: string;
        client: string;
        ice: string | null;
        ht: string;
        vat: string;
        ttc: string;
        credit: string | null;
      }>(
        `select i.number, to_char(i.invoice_date, 'YYYY-MM-DD') as date, i.client_name as client, i.client_ice as ice,
                i.total_ht_centimes::text as ht, i.total_vat_centimes::text as vat, i.total_ttc_centimes::text as ttc,
                (select o.number from invoice o where o.id = i.credit_note_of) as credit
           from invoice i where i.invoice_date between $1 and $2 order by i.invoice_date, i.number`,
        [from, to],
      )
    ).rows.map((r): SalesRow => ({
      number: r.number,
      date: r.date,
      clientName: r.client,
      clientIce: r.ice,
      htCentimes: Number(r.ht),
      vatCentimes: Number(r.vat),
      ttcCentimes: Number(r.ttc),
      creditNoteOf: r.credit,
    }));
    const lines = await tx.query<{ s: string }>(
      `select coalesce(sum(l.line_ht_centimes), 0)::text as s from invoice_line l join invoice i on i.id = l.invoice_id
        where i.invoice_date between $1 and $2`,
      [from, to],
    );
    // The accountant reads no purchase table: nothing is asked of them (an empty journal would pass for a complete one).
    const readsPurchases = seesBalances(actor.role, INVOICE_ITEM);
    const purchases = (
      !readsPurchases
        ? { rows: [] }
        : await tx.query<{
            code: string;
            date: string;
            supplier: string;
            inv: string | null;
            due: string;
            ht: string;
            vat: string;
            ttc: string;
          }>(
            // The purchases journal is what was bought on the supplier's paper: orders that carry their own payable, and the supplier
            // invoices approved for payment (the order of an invoice-based payable is a commitment, not an entry).
            `select code, date, supplier, inv, due, ht, vat, ttc from (
           select p.code, to_char(p.order_date, 'YYYY-MM-DD') as date, s.name as supplier, p.supplier_invoice_no as inv,
                  to_char(p.due_date, 'YYYY-MM-DD') as due, p.total_ht_centimes::text as ht, p.total_vat_centimes::text as vat,
                  p.total_ttc_centimes::text as ttc
             from purchase p join supplier s on s.id = p.supplier_id
            where p.payable_source = 'order' and p.order_date between $1 and $2
           union all
           select si.code, to_char(si.invoice_date, 'YYYY-MM-DD'), f.name, si.supplier_invoice_no,
                  to_char(si.due_date, 'YYYY-MM-DD'), si.total_ht_centimes::text, si.total_vat_centimes::text, si.total_ttc_centimes::text
             from supplier_invoice si join supplier f on f.id = si.supplier_id
            where si.invoice_date between $1 and $2
              and (select e.event from supplier_invoice_event e where e.supplier_invoice_id = si.id order by e.seq desc limit 1) = 'approved'
         ) j order by date, code`,
            [from, to],
          )
    ).rows.map((r): PurchaseRow => ({
      code: r.code,
      date: r.date,
      supplierName: r.supplier,
      supplierInvoiceNo: r.inv,
      dueDate: r.due,
      htCentimes: Number(r.ht),
      vatCentimes: Number(r.vat),
      ttcCentimes: Number(r.ttc),
    }));
    const recon = reconcile({ sales, purchases, invoiceLinesHtCentimes: Number(lines.rows[0]?.s ?? 0) });
    if (!recon.ok) return err(recon.error);

    // F09: no balance, no treasury for a role that does not see them; the files are empty and nothing asks the refused doors.
    if (!seesBalances(actor.role, INVOICE_ITEM)) {
      return ok({
        from,
        to,
        files: {
          sales: salesJournalCsv(sales),
          purchases: '',
          payments: '',
          ageing: '',
        },
        summary: {
          invoices: sales.length,
          purchases: purchases.length,
          payments: 0,
          movements: 0,
          salesTtcCentimes: sales.reduce((s, r) => s + r.ttcCentimes, 0),
          purchasesTtcCentimes: 0,
        },
      });
    }

    const payments = (
      await tx.query<{
        date: string;
        direction: 'in' | 'out';
        method: string;
        number: string | null;
        party: string;
        amount: string;
        state: string;
      }>(
        `select to_char(i.received_date, 'YYYY-MM-DD') as date, i.direction, i.method, i.number,
                coalesce(c.name, s.name, '') as party, i.amount_centimes::text as amount, last.event as state
           from payment_instrument i
           left join client c on c.id = i.client_id left join supplier s on s.id = i.supplier_id
           cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
          where i.received_date between $1 and $2 order by i.received_date, i.number nulls last`,
        [from, to],
      )
    ).rows.map((r): PaymentRow => ({
      date: r.date,
      direction: r.direction,
      method: r.method,
      number: r.number,
      partyName: r.party,
      amountCentimes: Number(r.amount),
      state: r.state,
    }));
    const movements = (
      await tx.query<{ date: string; account: string; source: string; amount: string }>(
        `select to_char(m.movement_date, 'YYYY-MM-DD') as date, a.label as account, m.source, m.amount_centimes::text as amount
           from money_movement m join money_account a on a.id = m.account_id
          where m.movement_date between $1 and $2 order by m.movement_date, m.created_at`,
        [from, to],
      )
    ).rows.map((r): MovementRow => ({
      date: r.date,
      account: r.account,
      source: r.source,
      amountCentimes: Number(r.amount),
    }));

    const receivables = (
      await tx.query<{ party: string; doc: string; due: string; open: string }>(
        `select i.client_name as party, i.number as doc, to_char(i.due_date, 'YYYY-MM-DD') as due,
                (s.total_ttc_centimes - s.paid_centimes)::text as open
           from invoice i join public.invoice_payment_state() s on s.invoice_id = i.id
          where i.credit_note_of is null and i.invoice_date <= $1
          order by i.due_date, i.number`,
        [to],
      )
    ).rows
      .map((r): AgeingItem => ({
        party: r.party,
        document: r.doc,
        dueDate: r.due,
        openCentimes: Number(r.open),
      }))
      .filter((r) => r.openCentimes > 0);
    const payables = (
      await tx.query<{ party: string; doc: string; due: string; open: string }>(
        `select s.name as party, p.code as doc, to_char(i.due_date, 'YYYY-MM-DD') as due,
                (i.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.purchase_plan_item_id = i.id), 0))::text as open
           from purchase_plan_item i join purchase p on p.id = i.purchase_id join supplier s on s.id = p.supplier_id
          where i.reverses_id is null and p.reverses_id is null and p.order_date <= $1
            and not exists (select 1 from purchase r where r.reverses_id = p.id)
          order by i.due_date, p.code`,
        [to],
      )
    ).rows
      .map((r): AgeingItem => ({
        party: r.party,
        document: r.doc,
        dueDate: r.due,
        openCentimes: Number(r.open),
      }))
      .filter((r) => r.openCentimes > 0);

    return ok({
      from,
      to,
      files: {
        sales: salesJournalCsv(sales),
        purchases: purchasesJournalCsv(purchases),
        payments: paymentsCsv(payments, movements),
        ageing: ageingCsv(to, receivables, payables),
      },
      summary: {
        invoices: sales.length,
        purchases: purchases.length,
        payments: payments.length,
        movements: movements.length,
        salesTtcCentimes: sales.reduce((s, r) => s + r.ttcCentimes, 0),
        purchasesTtcCentimes: purchases.reduce((s, r) => s + r.ttcCentimes, 0),
      },
    });
  });
}
