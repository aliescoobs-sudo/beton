import type pg from 'pg';
import { addCentimes, type Centimes, centimes, mulDivRound } from '@/lib/money';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { can } from '@/modules/platform-security';

export interface QueueDelivery {
  deliveryId: string;
  blNo: string;
  loadDate: string;
  deliveredAt: string;
  volumeL: number;
  typeCode: string;
  typeLabel: string;
  /** Owner and support only: the load at its order's price, HT, one rounding. */
  amountHtCentimes?: number;
}

export interface QueueClient {
  clientId: string;
  clientCode: string;
  clientName: string;
  deliveries: QueueDelivery[];
  totalVolumeL: number;
  /** Owner and support only. VAT is the rate of each order on the HT of its loads, one rounding per rate. */
  money?: { htCentimes: number; vatCentimes: number; ttcCentimes: number };
}

/**
 * The delivered loads no live invoice carries yet, per client (AC-INT-05). Owner, support and office read it: office through
 * the database function that returns no price, total or order (D84), so its answer has no money key at all; the owner and
 * support also get what each load comes to and what each client is owed to invoice.
 */
export async function getInvoiceQueue(appPool: pg.Pool, actor: SessionUser): Promise<QueueClient[]> {
  await require(appPool, actor, 'invoices.queue');
  const withMoney = can(actor.role, 'invoices.read');
  return inRequest(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{
      delivery_id: string;
      bl_no: string;
      load_date: string;
      delivered_at: string;
      volume_l: number;
      client_id: string;
      client_code: string;
      client_name: string;
      type_code: string;
      type_label: string;
    }>(
      `select delivery_id, bl_no, to_char(load_date, 'YYYY-MM-DD') as load_date,
              to_char(delivered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as delivered_at,
              volume_l, client_id, client_code, client_name, type_code, type_label
         from public.invoice_queue()`,
    );
    const amounts = new Map<string, { ht: number; rate: number }>();
    if (withMoney && rows.length > 0) {
      const money = await tx.query<{ id: string; price: string; volume_l: number; rate: number }>(
        `select d.id, o.unit_price_ht_centimes::text as price, d.volume_l, o.vat_rate_bp as rate
           from delivery d join sales_order o on o.id = d.order_id where d.id = any($1)`,
        [rows.map((r) => r.delivery_id)],
      );
      // The same arithmetic as the invoice: the load at the order's unit price, one rounding per load.
      for (const m of money.rows)
        amounts.set(m.id, { ht: mulDivRound(centimes(Number(m.price)), m.volume_l, 1000), rate: m.rate });
    }
    const byClient = new Map<string, QueueClient>();
    const htByRate = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const client =
        byClient.get(r.client_id) ??
        ({
          clientId: r.client_id,
          clientCode: r.client_code,
          clientName: r.client_name,
          deliveries: [],
          totalVolumeL: 0,
        } satisfies QueueClient);
      const amount = amounts.get(r.delivery_id);
      client.deliveries.push({
        deliveryId: r.delivery_id,
        blNo: r.bl_no,
        loadDate: r.load_date,
        deliveredAt: r.delivered_at,
        volumeL: r.volume_l,
        typeCode: r.type_code,
        typeLabel: r.type_label,
        ...(amount ? { amountHtCentimes: amount.ht } : {}),
      });
      client.totalVolumeL += r.volume_l;
      byClient.set(r.client_id, client);
      if (amount) {
        const rates = htByRate.get(r.client_id) ?? new Map<number, number>();
        rates.set(amount.rate, (rates.get(amount.rate) ?? 0) + amount.ht);
        htByRate.set(r.client_id, rates);
      }
    }
    if (withMoney) {
      for (const [clientId, rates] of htByRate) {
        let ht: Centimes = centimes(0);
        let vat: Centimes = centimes(0);
        for (const [rate, sum] of rates) {
          ht = addCentimes(ht, centimes(sum));
          vat = addCentimes(vat, mulDivRound(centimes(sum), rate, 10000));
        }
        const client = byClient.get(clientId);
        if (client) client.money = { htCentimes: ht, vatCentimes: vat, ttcCentimes: addCentimes(ht, vat) };
      }
    }
    return [...byClient.values()];
  });
}
