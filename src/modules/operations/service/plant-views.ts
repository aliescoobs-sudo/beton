import type pg from 'pg';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { remainingVolume } from '../domain/stock';

/** One order the plant can load: quantities and place only, never a price, total, plan or client contact (AC-OPS-09). */
export interface LoadableOrder {
  id: string;
  code: string;
  clientCode: string;
  typeCode: string;
  typeLabel: string;
  siteLabel: string | null;
  zoneName: string | null;
  deliveryDate: string;
  volumeL: number;
  remainingL: number;
}

/** Orders due on or before `today` that still have volume to deliver, oldest first. */
export async function listLoadableOrders(
  appPool: pg.Pool,
  actor: SessionUser,
  today: string,
): Promise<LoadableOrder[]> {
  await require(appPool, actor, 'deliveries.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      code: string;
      client_code: string;
      type_code: string;
      type_label: string;
      site_label: string | null;
      zone_name: string | null;
      delivery_date: string;
      volume_l: number;
      loaded_l: string;
    }>(
      `select o.id, o.code, o.client_code, t.code as type_code, t.label as type_label, o.site_label,
              z.name as zone_name, to_char(o.delivery_date, 'YYYY-MM-DD') as delivery_date, o.volume_l,
              coalesce((select sum(d.volume_l) from delivery d where d.order_id = o.id), 0)::text as loaded_l
         from sales_order_ops o
         join concrete_type t on t.id = o.concrete_type_id
         left join zone z on z.id = o.zone_id
        where o.reverses_id is null and not o.is_reversed and o.delivery_date <= $1
        order by o.delivery_date, o.code`,
      [today],
    ),
  );
  return rows
    .map((r) => ({
      id: r.id,
      code: r.code,
      clientCode: r.client_code,
      typeCode: r.type_code,
      typeLabel: r.type_label,
      siteLabel: r.site_label,
      zoneName: r.zone_name,
      deliveryDate: r.delivery_date,
      volumeL: r.volume_l,
      remainingL: remainingVolume(r.volume_l, [Number(r.loaded_l)]),
    }))
    .filter((o) => o.remainingL > 0);
}

export interface DeliveryRow {
  id: string;
  blNo: string;
  /** Null for office: it reads the load but not the order behind it (blind entry, DECISIONS 81). */
  orderCode: string | null;
  clientCode: string | null;
  typeCode: string | null;
  truckCode: string;
  volumeL: number;
  loadDate: string;
  cancelled: boolean;
  /** Present once the signed BL came back. */
  returnedOn: string | null;
}

/** The most recent loads (reversing rows included, shown as cancellations), newest first. */
export async function listDeliveries(
  appPool: pg.Pool,
  actor: SessionUser,
  limit = 50,
): Promise<DeliveryRow[]> {
  await require(appPool, actor, 'deliveries.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      bl_no: string;
      order_code: string | null;
      client_code: string | null;
      type_code: string | null;
      truck_code: string;
      volume_l: number;
      load_date: string;
      reverses_id: string | null;
      cancelled: boolean;
      returned_on: string | null;
    }>(
      `select d.id, d.bl_no, o.code as order_code, o.client_code, t.code as type_code, k.code as truck_code,
              d.volume_l, to_char(d.load_date, 'YYYY-MM-DD') as load_date, d.reverses_id,
              exists (select 1 from delivery r where r.reverses_id = d.id) as cancelled,
              (select to_char(r.returned_on, 'YYYY-MM-DD') from delivery_return r where r.delivery_id = d.id) as returned_on
         from delivery d
         left join sales_order_ops o on o.id = d.order_id
         left join concrete_type t on t.id = o.concrete_type_id
         join truck k on k.id = d.truck_id
        order by d.created_at desc, d.bl_no desc limit $1`,
      [limit],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    blNo: r.bl_no,
    orderCode: r.order_code,
    clientCode: r.client_code,
    typeCode: r.type_code,
    truckCode: r.truck_code,
    volumeL: r.volume_l,
    loadDate: r.load_date,
    cancelled: r.cancelled || r.reverses_id !== null,
    returnedOn: r.returned_on,
  }));
}
