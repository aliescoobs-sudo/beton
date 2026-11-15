import type pg from 'pg';
import {
  inRequest,
  isMalformedId,
  recordMoneyExport,
  require,
  type SessionUser,
} from '@/modules/platform-security';

/** What is printed on a delivery note (AC-OPS-11): names, places and quantities. Never a price, total, plan or payment. */
export interface DeliveryNote {
  blNo: string;
  loadDate: string;
  loadedAt: string;
  volumeL: number;
  cancelled: boolean;
  orderCode: string;
  /** T19 item 4: the client's own purchase-order number of the order, when one was entered (shown on the BL). */
  clientPo: string | null;
  clientCode: string;
  /** Null for plant: it sees the client code only. */
  clientName: string | null;
  siteLabel: string | null;
  zoneName: string | null;
  typeCode: string;
  typeLabel: string;
  truckCode: string;
  truckPlate: string;
}

/** The note of one delivery, or null when it does not exist. Every role that reads deliveries may print it. */
export async function getDeliveryNote(
  appPool: pg.Pool,
  actor: SessionUser,
  deliveryId: string,
): Promise<DeliveryNote | null> {
  await require(appPool, actor, 'deliveries.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{
        bl_no: string;
        load_date: string;
        loaded_at: Date;
        volume_l: number;
        cancelled: boolean;
        order_code: string;
        client_code: string;
        client_name: string | null;
        site_label: string | null;
        zone_name: string | null;
        type_code: string;
        type_label: string;
        truck_code: string;
        truck_plate: string;
      }>(
        `select bl_no, to_char(load_date, 'YYYY-MM-DD') as load_date, loaded_at, volume_l, cancelled, order_code,
                client_code, client_name, site_label, zone_name, type_code, type_label, truck_code, truck_plate
           from public.delivery_note($1)`,
        [deliveryId],
      ),
    );
    const r = rows[0];
    if (!r) return null;
    const po = await inRequest(appPool, actor, (tx) =>
      tx.query<{ o_client_po: string }>('select o_client_po from public.order_client_pos($1::text[])', [
        [r.order_code],
      ]),
    );
    return {
      clientPo: po.rows[0]?.o_client_po ?? null,
      blNo: r.bl_no,
      loadDate: r.load_date,
      loadedAt: r.loaded_at.toISOString(),
      volumeL: r.volume_l,
      cancelled: r.cancelled,
      orderCode: r.order_code,
      clientCode: r.client_code,
      clientName: r.client_name,
      siteLabel: r.site_label,
      zoneName: r.zone_name,
      typeCode: r.type_code,
      typeLabel: r.type_label,
      truckCode: r.truck_code,
      truckPlate: r.truck_plate,
    };
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}

/** A print of a delivery note is audited like any export: what leaves the screen leaves the application (DECISIONS 82). */
export function recordNotePrint(appPool: pg.Pool, actor: SessionUser, blNo: string): Promise<void> {
  return recordMoneyExport(appPool, actor, `print:delivery-note:${blNo}`);
}
