import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { inRequestRolledBack, require, type SessionUser } from '@/modules/platform-security';
import { invoiceDueDate, parseInvoiceInput } from '../domain/invoice';
import { groupInvoiceLines, type InvoiceGroup, netToPay } from '../domain/invoice-groups';
import { type InvoiceError, insertInvoiceRows, invoiceFailure } from './invoice-service';

export interface InvoicePreview {
  /** The lines as the document will show them: one per product and price, the quantity summed, the BL numbers listed. */
  groups: InvoiceGroup[];
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  /** "Acompte reçu": the advances the client paid on these orders, applied by the invoice itself. */
  advanceCentimes: number;
  /** "Net à payer". */
  netToPayCentimes: number;
}

/**
 * What the invoice of these BLs would be, made by the very function that makes it: the invoice is created in a transaction that is
 * rolled back, read in that transaction, and gone (no row, no number, no audit event stays). So the lines, the advances and the
 * totals are the database's own, not a copy of its rules. Owner and support read it (`invoices.read`); a BL that is already invoiced,
 * not delivered or of another client fails here as it would at the creation.
 */
export async function previewInvoiceFromDeliveries(
  appPool: pg.Pool,
  actor: SessionUser,
  deliveryIds: string[],
  deps: { today: string },
): Promise<Result<InvoicePreview, InvoiceError>> {
  await require(appPool, actor, 'invoices.read');
  const parsed = parseInvoiceInput({ deliveryIds });
  if (!parsed.ok) return err('INVALID');
  const due = invoiceDueDate(deps.today, null);
  if (!due.ok) return err(due.error);
  try {
    return await inRequestRolledBack(
      appPool,
      actor,
      async (tx): Promise<Result<InvoicePreview, InvoiceError>> => {
        const made = await insertInvoiceRows(tx, actor, parsed.value, due.value, deps.today);
        if (!made.ok) return made;
        const head = await tx.query<{ id: string; ht: string; vat: string; ttc: string }>(
          `select id, total_ht_centimes::text as ht, total_vat_centimes::text as vat, total_ttc_centimes::text as ttc
           from invoice where number = $1 and credit_note_of is null`,
          [made.value.number],
        );
        const h = head.rows[0];
        if (!h) return err('NOT_FOUND');
        const lines = await tx.query<{
          volume_l: number;
          price: string;
          total: string;
          bl_no: string;
          type_code: string;
          type_label: string;
        }>(
          `select l.volume_l, l.unit_price_ht_centimes::text as price, l.line_ht_centimes::text as total, d.bl_no,
                t.code as type_code, t.label as type_label
           from invoice_line l
           join delivery d on d.id = l.delivery_id
           join sales_order o on o.id = d.order_id
           join concrete_type t on t.id = o.concrete_type_id
          where l.invoice_id = $1 order by l.seq`,
          [h.id],
        );
        const advance = await tx.query<{ amount: string }>(
          `select coalesce(sum(amount_centimes), 0)::text as amount from invoice_advance where invoice_id = $1`,
          [h.id],
        );
        const advanceCentimes = Number(advance.rows[0]?.amount ?? 0);
        return ok({
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
          totalHtCentimes: Number(h.ht),
          totalVatCentimes: Number(h.vat),
          totalTtcCentimes: Number(h.ttc),
          advanceCentimes,
          netToPayCentimes: netToPay(Number(h.ttc), advanceCentimes),
        });
      },
    );
  } catch (error) {
    return err(invoiceFailure(error));
  }
}
