import type pg from 'pg';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { byDeadline, type Deadline, deadlineStatus } from '../domain/deadlines';
import { invoiceIssueDeadline } from '../domain/invoice';

/**
 * The legal dates both ways (law 69-21), derived and never stored: invoices still to issue by the end of the delivery month,
 * invoices to collect on their due date, purchases to pay on theirs. Alerts built on them belong to the rules engine; this is
 * only the read model. Owner and support (money).
 */
export async function legalDeadlines(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { asOf: string },
): Promise<Deadline[]> {
  await require(appPool, actor, 'due_items.read');
  const asOf = deps.asOf;
  return inRequest(appPool, actor, async (tx) => {
    const toIssue = await tx.query<{ code: string; client: string; first_load: string }>(
      `select o.code, c.name as client, to_char(min(d.load_date), 'YYYY-MM-DD') as first_load
         from delivery d
         join sales_order o on o.id = d.order_id
         join client c on c.id = o.client_id
        where d.reverses_id is null
          and not exists (select 1 from delivery r where r.reverses_id = d.id)
          and not exists (select 1 from sales_order r where r.reverses_id = o.id)
          and not exists (
            select 1 from invoice_line l join invoice i on i.id = l.invoice_id
             where l.delivery_id = d.id and i.credit_note_of is null
               and not exists (select 1 from invoice cn where cn.credit_note_of = i.id))
        group by o.id, o.code, c.name`,
    );
    const receivables = await tx.query<{
      number: string;
      client: string;
      due: string;
      total: string;
      paid: boolean;
    }>(
      `select i.number, i.client_name as client, to_char(i.due_date, 'YYYY-MM-DD') as due, i.total_ttc_centimes::text as total,
              coalesce((select sum(a.amount_centimes) from allocation a join payment_plan_item p on p.id = a.payment_plan_item_id
                         where p.order_id = i.order_id), 0) >= (select o.total_ttc_centimes from sales_order o where o.id = i.order_id) as paid
         from invoice i
        where i.credit_note_of is null and not exists (select 1 from invoice cn where cn.credit_note_of = i.id)`,
    );
    const payables = await tx
      .query<{ code: string; supplier: string; due: string; open: string }>(
        `select p.code, s.name as supplier, to_char(i.due_date, 'YYYY-MM-DD') as due,
              (i.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.purchase_plan_item_id = i.id), 0))::text as open
         from purchase_plan_item i
         join purchase p on p.id = i.purchase_id
         join supplier s on s.id = p.supplier_id
        where i.reverses_id is null and p.reverses_id is null
          and not exists (select 1 from purchase r where r.reverses_id = p.id)`,
      )
      .catch(() => ({ rows: [] as { code: string; supplier: string; due: string; open: string }[] }));
    const out: Deadline[] = [
      ...toIssue.rows.map((r) => {
        const date = invoiceIssueDeadline(r.first_load);
        return {
          kind: 'invoice_to_issue' as const,
          date,
          status: deadlineStatus(date, asOf),
          documentCode: r.code,
          partyName: r.client,
          amountCentimes: null,
        };
      }),
      ...receivables.rows
        .filter((r) => !r.paid)
        .map((r) => ({
          kind: 'receivable_due' as const,
          date: r.due,
          status: deadlineStatus(r.due, asOf),
          documentCode: r.number,
          partyName: r.client,
          amountCentimes: Number(r.total),
        })),
      ...payables.rows
        .filter((r) => Number(r.open) > 0)
        .map((r) => ({
          kind: 'payable_due' as const,
          date: r.due,
          status: deadlineStatus(r.due, asOf),
          documentCode: r.code,
          partyName: r.supplier,
          amountCentimes: Number(r.open),
        })),
    ];
    return out.sort(byDeadline);
  });
}
