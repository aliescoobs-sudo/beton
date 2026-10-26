import type pg from 'pg';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';

export interface OrderChainRow {
  orderId: string;
  code: string;
  clientCode: string;
  typeCode: string;
  orderDate: string;
  deliveryDate: string;
  orderedL: number;
  plannedL: number;
  loadedL: number;
  deliveredL: number;
  invoicedL: number;
  /** The payment state of the order: owner and support only. NULL for every other role (the stage is masked). */
  paidState: 'unpaid' | 'partial' | 'paid' | null;
  cancelled: boolean;
}

/**
 * One row per order with the stages ordered, planned, loaded, delivered, invoiced and paid (AC-INT-16). Every role of the
 * company reads quantities and stages (litres); the payment stage is the owner's and support's, the others get none. No amount
 * leaves the database, whoever asks. Newest delivery date first, 300 at most.
 */
export async function getOrderChain(appPool: pg.Pool, actor: SessionUser): Promise<OrderChainRow[]> {
  await require(appPool, actor, 'orders.chain');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      order_id: string;
      code: string;
      client_code: string;
      type_code: string;
      order_date: string;
      delivery_date: string;
      ordered_l: number;
      planned_l: string;
      loaded_l: string;
      delivered_l: string;
      invoiced_l: string;
      paid_state: 'unpaid' | 'partial' | 'paid' | null;
      cancelled: boolean;
    }>(
      `select order_id, code, client_code, type_code, to_char(order_date, 'YYYY-MM-DD') as order_date,
              to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, ordered_l, planned_l::text, loaded_l::text,
              delivered_l::text, invoiced_l::text, paid_state, cancelled
         from public.order_chain()`,
    ),
  );
  return rows.map((r) => ({
    orderId: r.order_id,
    code: r.code,
    clientCode: r.client_code,
    typeCode: r.type_code,
    orderDate: r.order_date,
    deliveryDate: r.delivery_date,
    orderedL: r.ordered_l,
    plannedL: Number(r.planned_l),
    loadedL: Number(r.loaded_l),
    deliveredL: Number(r.delivered_l),
    invoicedL: Number(r.invoiced_l),
    paidState: r.paid_state,
    cancelled: r.cancelled,
  }));
}
