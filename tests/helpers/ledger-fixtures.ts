import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '../../src/lib/db/rls-context';

/** Master data an order needs: an active client, an active concrete type and a list price in force from 2000. */
export interface OrderMaster {
  clientId: string;
  typeId: string;
  sellingPriceId: string;
  unitPriceCentimes: number;
}

const cache = new Map<string, Promise<OrderMaster>>();

/** Created once per marker, by the owner (only the owner writes prices, DECISIONS 81). The client's name is `fx<marker>` (apart from the `<marker>:` names other fixtures match on). */
export function orderMaster(app: pg.Pool, ownerId: string, marker: string): Promise<OrderMaster> {
  let made = cache.get(marker);
  if (!made) {
    made = withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
      const client = await tx.query<{ id: string }>(
        `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
        [`fx${marker}`],
      );
      const type = await tx.query<{ id: string }>(
        `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'F' || upper(substr(md5(random()::text), 1, 8)), $1) returning id`,
        [`fx${marker}`],
      );
      const price = await tx.query<{ id: string }>(
        `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
         values (gen_random_uuid(), $1, null, 78000, '2000-01-01', $2) returning id`,
        [type.rows[0]?.id, ownerId],
      );
      return {
        clientId: client.rows[0]?.id as string,
        typeId: type.rows[0]?.id as string,
        sellingPriceId: price.rows[0]?.id as string,
        unitPriceCentimes: 78_000,
      };
    });
    cache.set(marker, made);
  }
  return made;
}

/**
 * Inserts one order of 10 m³ (HT 7 800,00, VAT 20 % 1 560,00, TTC 9 360,00) with a single plan item, the way the service
 * does: number from next_doc_number, no RETURNING (office cannot read back). Run it inside the actor's transaction.
 */
export async function insertOrder(
  tx: pg.PoolClient,
  actorId: string,
  master: OrderMaster,
): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = (await tx.query<{ n: string }>(`select public.next_doc_number('CMD', 2026, 5) as n`)).rows[0]
    ?.n as string;
  await tx.query(
    `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                              unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
     values ($1, $2, $3, $4, 10000, '2026-06-01', '2026-06-02', $5, $6, 2000, 780000, 156000, 936000, $7)`,
    [id, code, master.clientId, master.typeId, master.sellingPriceId, master.unitPriceCentimes, actorId],
  );
  await tx.query(
    `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
     values (gen_random_uuid(), $1, 1, 'in', 'cash', '2026-06-02', 936000, $2)`,
    [id, actorId],
  );
  return { id, code };
}
