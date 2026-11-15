import type pg from 'pg';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { type ItemState, itemState } from '../domain/plan-state';

export interface OrderRow {
  id: string;
  code: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  typeCode: string;
  /** GOULOTTE or POMPE; null for a legacy order ("method not recorded", D242: never counted as GOULOTTE). */
  dischargeMethod: string | null;
  volumeL: number;
  deliveredL: number;
  orderDate: string;
  deliveryDate: string;
  totalTtcCentimes: number;
  coveredCentimes: number;
  /** What is past its due date and not covered, over the plan items. */
  overdueCentimes: number;
  invoiced: boolean;
  /** Cancelled by a later reversing row. */
  cancelled: boolean;
}

/** The orders with what has been delivered and paid, newest first. Owner and support only (money, DECISIONS 81). */
export async function listOrders(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string },
): Promise<OrderRow[]> {
  await require(appPool, actor, 'orders.read_money');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      code: string;
      client_id: string;
      client_code: string;
      client_name: string;
      type_code: string;
      discharge_method: string | null;
      volume_l: number;
      delivered_l: string;
      order_date: string;
      delivery_date: string;
      total: string;
      covered: string;
      overdue: string;
      invoiced: boolean;
      cancelled: boolean;
    }>(
      `select o.id, o.code, o.client_id, c.code as client_code, c.name as client_name, t.code as type_code, o.discharge_method, o.volume_l,
              coalesce((select sum(g.volume_l) from delivered_load g where g.order_id = o.id), 0)::text as delivered_l,
              to_char(o.order_date, 'YYYY-MM-DD') as order_date, to_char(o.delivery_date, 'YYYY-MM-DD') as delivery_date,
              o.total_ttc_centimes::text as total,
              coalesce((select sum(a.amount_centimes) from allocation a join payment_plan_item i on i.id = a.payment_plan_item_id
                         where i.order_id = o.id), 0)::text as covered,
              coalesce((select sum(i.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.payment_plan_item_id = i.id), 0))
                          from payment_plan_item i
                         where i.order_id = o.id and i.reverses_id is null and i.due_date < $1::date
                           and i.amount_centimes > coalesce((select sum(a.amount_centimes) from allocation a where a.payment_plan_item_id = i.id), 0)), 0)::text as overdue,
              exists (select 1 from invoice_line l join invoice v on v.id = l.invoice_id join delivery d on d.id = l.delivery_id
                       where d.order_id = o.id and v.credit_note_of is null
                         and not exists (select 1 from invoice cn where cn.credit_note_of = v.id)) as invoiced,
              exists (select 1 from sales_order r where r.reverses_id = o.id) as cancelled
         from sales_order o
         join client c on c.id = o.client_id
         join concrete_type t on t.id = o.concrete_type_id
        where o.reverses_id is null
        order by o.order_date desc, o.code desc`,
      [deps.today],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    clientId: r.client_id,
    clientCode: r.client_code,
    clientName: r.client_name,
    typeCode: r.type_code,
    dischargeMethod: r.discharge_method,
    volumeL: r.volume_l,
    deliveredL: Number(r.delivered_l),
    orderDate: r.order_date,
    deliveryDate: r.delivery_date,
    totalTtcCentimes: Number(r.total),
    coveredCentimes: Number(r.covered),
    overdueCentimes: Number(r.cancelled ? 0 : r.overdue),
    invoiced: r.invoiced,
    cancelled: r.cancelled,
  }));
}

export interface OrderDetail {
  order: OrderRow & {
    unitPriceHtCentimes: number;
    vatRateBp: number;
    totalHtCentimes: number;
    totalVatCentimes: number;
    reason: string | null;
  };
  items: {
    seq: number;
    method: string;
    dueDate: string;
    amountCentimes: number;
    coveredCentimes: number;
    state: ItemState;
  }[];
  loads: { blNo: string; loadDate: string; volumeL: number; truckCode: string; cancelled: boolean }[];
  invoices: { number: string; invoiceDate: string; totalTtcCentimes: number; creditNote: boolean }[];
  payments: { number: string | null; method: string; amountCentimes: number; coveredCentimes: number }[];
}

/** One order with its plan items and their state, its loads, its invoices and the payments that cover it (owner, support). */
export async function getOrderDetail(
  appPool: pg.Pool,
  actor: SessionUser,
  orderId: string,
  deps: { today: string },
): Promise<OrderDetail | null> {
  await require(appPool, actor, 'orders.read_money');
  try {
    const list = (await listOrders(appPool, actor, deps)).find((o) => o.id === orderId);
    if (!list) return null;
    return await inRequest(appPool, actor, async (tx): Promise<OrderDetail> => {
      const head = await tx.query<{
        unit: string;
        vat: number;
        ht: string;
        vatc: string;
        reason: string | null;
      }>(
        `select unit_price_ht_centimes::text as unit, vat_rate_bp as vat, total_ht_centimes::text as ht,
                total_vat_centimes::text as vatc, reason from sales_order where id = $1`,
        [orderId],
      );
      const items = await tx.query<{
        seq: number;
        method: string;
        due: string;
        amount: string;
        covered: string;
      }>(
        `select i.seq, i.method, to_char(i.due_date, 'YYYY-MM-DD') as due, i.amount_centimes::text as amount,
                coalesce((select sum(a.amount_centimes) from allocation a where a.payment_plan_item_id = i.id), 0)::text as covered
           from payment_plan_item i where i.order_id = $1 and i.reverses_id is null order by i.seq`,
        [orderId],
      );
      const loads = await tx.query<{
        bl_no: string;
        load_date: string;
        volume_l: number;
        truck: string;
        cancelled: boolean;
      }>(
        `select d.bl_no, to_char(d.load_date, 'YYYY-MM-DD') as load_date, d.volume_l, k.code as truck,
                (d.reverses_id is not null or exists (select 1 from delivery r where r.reverses_id = d.id)) as cancelled
           from delivery d join truck k on k.id = d.truck_id where d.order_id = $1 order by d.load_date, d.bl_no`,
        [orderId],
      );
      const invoices = await tx.query<{ number: string; date: string; total: string; credit: boolean }>(
        `select number, to_char(invoice_date, 'YYYY-MM-DD') as date, total_ttc_centimes::text as total,
                (credit_note_of is not null) as credit from invoice
                 where id in (select l.invoice_id from invoice_line l join delivery d on d.id = l.delivery_id where d.order_id = $1)
                 order by invoice_date, number`,
        [orderId],
      );
      const payments = await tx.query<{
        number: string | null;
        method: string;
        amount: string;
        covered: string;
      }>(
        `select p.number, p.method, p.amount_centimes::text as amount, sum(a.amount_centimes)::text as covered
           from allocation a
           join payment_instrument p on p.id = a.instrument_id
           join payment_plan_item i on i.id = a.payment_plan_item_id
          where i.order_id = $1 group by p.id, p.number, p.method, p.amount_centimes, p.received_date
         having sum(a.amount_centimes) <> 0 order by p.received_date`,
        [orderId],
      );
      const h = head.rows[0];
      return {
        order: {
          ...list,
          unitPriceHtCentimes: Number(h?.unit),
          vatRateBp: Number(h?.vat),
          totalHtCentimes: Number(h?.ht),
          totalVatCentimes: Number(h?.vatc),
          reason: h?.reason ?? null,
        },
        items: items.rows.map((r) => ({
          seq: r.seq,
          method: r.method,
          dueDate: r.due,
          amountCentimes: Number(r.amount),
          coveredCentimes: Number(r.covered),
          state: itemState({
            amountCentimes: Number(r.amount),
            coveredCentimes: Number(r.covered),
            dueDate: r.due,
            today: deps.today,
            cancelled: list.cancelled,
          }),
        })),
        loads: loads.rows.map((r) => ({
          blNo: r.bl_no,
          loadDate: r.load_date,
          volumeL: r.volume_l,
          truckCode: r.truck,
          cancelled: r.cancelled,
        })),
        invoices: invoices.rows.map((r) => ({
          number: r.number,
          invoiceDate: r.date,
          totalTtcCentimes: Number(r.total),
          creditNote: r.credit,
        })),
        payments: payments.rows.map((r) => ({
          number: r.number,
          method: r.method,
          amountCentimes: Number(r.amount),
          coveredCentimes: Number(r.covered),
        })),
      };
    });
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}
