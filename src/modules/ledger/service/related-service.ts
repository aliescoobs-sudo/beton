import type pg from 'pg';
import { z } from 'zod';
import { can, inRequest, isMalformedId, type Role, type SessionUser } from '@/modules/platform-security';
import { type RelatedDocument, type RelatedKind, uniqueRelated } from '../domain/related';

export type RelatedSubject = 'bl' | 'order' | 'invoice' | 'quote' | 'purchase' | 'supplier_invoice';

/** The page that opens a document for this role, or null: the number is shown, not linked (AC-INT-17). */
function pathFor(role: Role, kind: RelatedKind, id: string): string | null {
  switch (kind) {
    case 'bl':
      return can(role, 'deliveries.read') ? `/deliveries/${id}` : null;
    case 'order':
      return can(role, 'orders.read_money') ? `/orders/${id}` : null;
    case 'invoice':
      return can(role, 'invoices.read') ? `/invoices/${id}` : null;
    case 'quote':
      return can(role, 'quotes.read') ? `/quotes/${id}` : null;
    case 'purchase':
      return can(role, 'purchases.read_money') ? `/purchases/${id}` : null;
    case 'supplier_invoice':
      return can(role, 'supplier_invoices.read') ? `/supplier-invoices/${id}` : null;
    case 'avoir':
      return can(role, 'avoirs.read') ? '/avoirs' : null;
    case 'payment':
      return can(role, 'instruments.read') ? '/instruments' : null;
    case 'receipt':
      return can(role, 'receipts.read') ? '/receipts' : null;
    default:
      return null;
  }
}

type Row = { id: string; code: string };
const rel = (role: Role, kind: RelatedKind, rows: Row[]): RelatedDocument[] =>
  rows.map((r) => ({ kind, code: r.code, path: pathFor(role, kind, r.id) }));

/**
 * The documents next to this one, from the database relations and only what the caller's row-level security lets it read
 * (AC-INT-17): a payment or an invoice is not even named to a role that reads no money; an order the caller cannot open is a
 * number with no link; a BL is open to everyone. Nothing here carries an amount.
 *   bl: its order, the invoices that bill it, the avoirs for it, the payments covering its order
 *   order: its BLs, its invoices, its avoirs, its payments, the quote it came from
 *   invoice: the orders and BLs it bills, the avoirs, the payments covering those orders
 *   quote: the order made from it
 *   purchase: its receipts, its supplier invoices, the payments covering it
 *   supplier_invoice: its order, the receipts it covers, the payments covering its payable
 */
export async function getRelatedDocuments(
  appPool: pg.Pool,
  actor: SessionUser,
  subject: { kind: RelatedSubject; id: string },
): Promise<RelatedDocument[]> {
  const parsed = z.uuid().safeParse(subject.id);
  if (!parsed.success) return [];
  const role = actor.role;
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const q = async (sql: string, ...params: unknown[]): Promise<Row[]> =>
        (await tx.query<Row>(sql, params)).rows;
      const out: RelatedDocument[] = [];
      const payments = (sql: string, id: string) => q(sql, id);
      switch (subject.kind) {
        case 'bl': {
          // The order of a load: the operational view for the roles that read it, else what the delivery note prints.
          const order = await q(
            `select o.id, o.code from sales_order_ops o join delivery d on d.order_id = o.id where d.id = $1`,
            subject.id,
          );
          if (order.length > 0) out.push(...rel(role, 'order', order));
          else {
            const note = await tx
              .query<{ code: string }>(`select order_code as code from public.delivery_note($1)`, [
                subject.id,
              ])
              .catch(() => ({ rows: [] as { code: string }[] }));
            out.push(...note.rows.map((r) => ({ kind: 'order' as const, code: r.code, path: null })));
          }
          out.push(
            ...rel(
              role,
              'invoice',
              await q(
                `select distinct i.id, i.number as code from invoice_line l join invoice i on i.id = l.invoice_id
                  where l.delivery_id = $1`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'avoir',
              await q(`select id, number as code from avoir where delivery_id = $1`, subject.id),
            ),
            ...rel(
              role,
              'payment',
              await payments(
                `select distinct p.id, coalesce(p.number, p.method) as code
                   from delivery d
                   join payment_plan_item pi on pi.order_id = d.order_id
                   join allocation a on a.payment_plan_item_id = pi.id
                   join payment_instrument p on p.id = a.instrument_id
                  where d.id = $1`,
                subject.id,
              ),
            ),
          );
          break;
        }
        case 'order': {
          out.push(
            ...rel(
              role,
              'bl',
              await q(
                `select id, bl_no as code from delivery where order_id = $1 and reverses_id is null`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'invoice',
              await q(
                `select distinct i.id, i.number as code from invoice_line l join invoice i on i.id = l.invoice_id
                   join delivery d on d.id = l.delivery_id where d.order_id = $1`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'avoir',
              await q(
                `select a.id, a.number as code from avoir a join delivery d on d.id = a.delivery_id where d.order_id = $1`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'payment',
              await payments(
                `select distinct p.id, coalesce(p.number, p.method) as code
                   from payment_plan_item pi join allocation a on a.payment_plan_item_id = pi.id
                   join payment_instrument p on p.id = a.instrument_id where pi.order_id = $1`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'quote',
              await q(
                `select qt.id, qt.code from quote qt join sales_order o on o.quote_id = qt.id where o.id = $1`,
                subject.id,
              ),
            ),
          );
          break;
        }
        case 'invoice': {
          out.push(
            ...rel(
              role,
              'order',
              await q(
                `select distinct o.id, o.code from invoice_line l join delivery d on d.id = l.delivery_id
                   join sales_order o on o.id = d.order_id where l.invoice_id = $1`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'bl',
              await q(
                `select distinct d.id, d.bl_no as code from invoice_line l join delivery d on d.id = l.delivery_id where l.invoice_id = $1`,
                subject.id,
              ),
            ),
            ...rel(
              role,
              'avoir',
              await q(`select id, number as code from avoir where invoice_id = $1`, subject.id),
            ),
            ...rel(
              role,
              'payment',
              await payments(
                `select distinct p.id, coalesce(p.number, p.method) as code
                   from invoice_line l join delivery d on d.id = l.delivery_id
                   join payment_plan_item pi on pi.order_id = d.order_id
                   join allocation a on a.payment_plan_item_id = pi.id
                   join payment_instrument p on p.id = a.instrument_id
                  where l.invoice_id = $1`,
                subject.id,
              ),
            ),
          );
          break;
        }
        case 'quote': {
          out.push(
            ...rel(
              role,
              'order',
              await q(`select id, code from sales_order where quote_id = $1`, subject.id),
            ),
          );
          break;
        }
        case 'purchase': {
          out.push(
            ...(
              await q(
                `select id, to_char(received_date, 'YYYY-MM-DD') as code from purchase_receipt where purchase_id = $1 order by received_date`,
                subject.id,
              )
            ).map((r) => ({ kind: 'receipt' as const, code: r.code, path: pathFor(role, 'receipt', r.id) })),
            ...rel(
              role,
              'supplier_invoice',
              await q(`select id, code from supplier_invoice where purchase_id = $1`, subject.id),
            ),
            ...rel(
              role,
              'payment',
              await payments(
                `select distinct p.id, coalesce(p.number, p.method) as code
                   from purchase_plan_item pi join allocation a on a.purchase_plan_item_id = pi.id
                   join payment_instrument p on p.id = a.instrument_id where pi.purchase_id = $1`,
                subject.id,
              ),
            ),
          );
          break;
        }
        case 'supplier_invoice': {
          out.push(
            ...rel(
              role,
              'purchase',
              await q(
                `select p.id, p.code from purchase p join supplier_invoice s on s.purchase_id = p.id where s.id = $1`,
                subject.id,
              ),
            ),
            ...(
              await q(
                `select r.id, to_char(r.received_date, 'YYYY-MM-DD') as code
                   from supplier_invoice_receipt x join purchase_receipt r on r.id = x.purchase_receipt_id
                  where x.supplier_invoice_id = $1 order by r.received_date`,
                subject.id,
              )
            ).map((r) => ({ kind: 'receipt' as const, code: r.code, path: pathFor(role, 'receipt', r.id) })),
            ...rel(
              role,
              'payment',
              await payments(
                `select distinct p.id, coalesce(p.number, p.method) as code
                   from purchase_plan_item pi join allocation a on a.purchase_plan_item_id = pi.id
                   join payment_instrument p on p.id = a.instrument_id where pi.supplier_invoice_id = $1`,
                subject.id,
              ),
            ),
          );
          break;
        }
      }
      return uniqueRelated(out);
    });
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}
