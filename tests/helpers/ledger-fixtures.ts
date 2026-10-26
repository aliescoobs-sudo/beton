import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '../../src/lib/db/rls-context';
import { consumptionForLoad } from '../../src/modules/operations';

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
  /** The delivery date (default 2026-06-02); the order date stays 2026-06-01. */
  deliveryDate = '2026-06-02',
): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = (await tx.query<{ n: string }>(`select public.next_doc_number('CMD', 2026, 5) as n`)).rows[0]
    ?.n as string;
  await tx.query(
    `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                              unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
     values ($1, $2, $3, $4, 10000, '2026-06-01', $8, $5, $6, 2000, 780000, 156000, 936000, $7)`,
    [
      id,
      code,
      master.clientId,
      master.typeId,
      master.sellingPriceId,
      master.unitPriceCentimes,
      actorId,
      deliveryDate,
    ],
  );
  await tx.query(
    `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
     values (gen_random_uuid(), $1, 1, 'in', 'cash', '2026-06-02', 936000, $2)`,
    [id, actorId],
  );
  return { id, code };
}

/** A bank account and a supplier for instrument tests, plus a caisse when the database has none. Created once per marker by the owner. */
export interface MoneyMaster {
  bankId: string;
  supplierId: string;
}
const moneyCache = new Map<string, Promise<MoneyMaster>>();

export function moneyMaster(app: pg.Pool, ownerId: string, marker: string): Promise<MoneyMaster> {
  let made = moneyCache.get(marker);
  if (!made) {
    made = withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
      const caisse = await tx.query<{ n: string }>(
        `select count(*)::text as n from money_account where kind = 'cash'`,
      );
      if (caisse.rows[0]?.n === '0') {
        await tx.query(
          `insert into money_account (id, kind, label, created_by) values (gen_random_uuid(), 'cash', $1, $2)`,
          [`Caisse ${randomUUID().replace(/-/g, '').slice(0, 12)}`, ownerId],
        );
      }
      const bank = await tx.query<{ id: string }>(
        `insert into money_account (id, kind, label, bank_name, created_by) values (gen_random_uuid(), 'bank', $1, 'Banque test', $2) returning id`,
        [`Banque ${randomUUID().replace(/-/g, '').slice(0, 12)}`, ownerId],
      );
      const supplier = await tx.query<{ id: string }>(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other') returning id`,
        [`fxs${marker}`],
      );
      return { bankId: bank.rows[0]?.id as string, supplierId: supplier.rows[0]?.id as string };
    });
    moneyCache.set(marker, made);
  }
  return made;
}

/**
 * Inserts an instrument and its first event as the actor, the way the service does (no RETURNING). `method` defaults to
 * an incoming cheque of 5 000,00 received and written on 2026-06-01. Cash also gets its same-day clearing into the caisse.
 */
export async function insertInstrument(
  tx: pg.PoolClient,
  actorId: string,
  p: {
    direction?: 'in' | 'out';
    method?: 'cash' | 'cheque' | 'lcn' | 'transfer';
    amountCentimes?: number;
    clientId?: string;
    supplierId?: string;
    writtenDate?: string;
    receivedDate?: string;
  },
): Promise<{ id: string }> {
  const direction = p.direction ?? 'in';
  const method = p.method ?? 'cheque';
  const received = p.receivedDate ?? '2026-06-01';
  const paper = method === 'cheque' || method === 'lcn';
  const id = randomUUID();
  await tx.query(
    `insert into payment_instrument (id, direction, method, amount_centimes, client_id, supplier_id, number, bank, written_date, received_date, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      direction,
      method,
      p.amountCentimes ?? 500_000,
      direction === 'in' ? p.clientId : null,
      direction === 'out' ? p.supplierId : null,
      paper ? `N${randomUUID().replace(/-/g, '').slice(0, 10)}` : null,
      method === 'cash' ? null : 'Banque test',
      paper ? (p.writtenDate ?? received) : null,
      received,
      actorId,
    ],
  );
  await tx.query(
    `insert into instrument_event (id, instrument_id, event, at_date, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`,
    [id, direction === 'in' ? 'received' : 'issued', received, actorId],
  );
  if (method === 'cash') {
    await tx.query(
      `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, created_by)
       values (gen_random_uuid(), $1, 'cleared', $2, public.default_cash_account(), $3)`,
      [id, received, actorId],
    );
  }
  return { id };
}

/** A movement written by the owner's cash clearing (through the trigger), for the tests that reverse or read movements. */
export async function newCashMovement(
  app: pg.Pool,
  ownerId: string,
  marker: string,
  clientId: string,
  amountCentimes = 123_400,
): Promise<{ id: string; accountId: string; amountCentimes: number }> {
  return withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
    const instrument = await insertInstrument(tx, ownerId, { method: 'cash', clientId, amountCentimes });
    const { rows } = await tx.query<{ id: string; account_id: string }>(
      `select id, account_id from money_movement where source = 'instrument' and source_id = $1`,
      [instrument.id],
    );
    return { id: rows[0]?.id as string, accountId: rows[0]?.account_id as string, amountCentimes };
  });
}

/** The reversing row of a movement, written directly (only the owner's policy lets it in). */
export function insertMovementReversal(
  tx: pg.PoolClient,
  actorId: string,
  original: { id: string; accountId: string; amountCentimes: number },
  reason: string,
) {
  return tx.query(
    `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, reverses_id, reason, created_by)
     values (gen_random_uuid(), $1, $2, '2026-06-02', 'reversal', $3, $3, $4, $5)`,
    [original.accountId, -original.amountCentimes, original.id, reason, actorId],
  );
}

/** An order of 9 360,00 TTC (one item) for a client of its own and a cheque of the same amount from that client, both by the owner. */
export interface AllocationScene {
  clientId: string;
  orderId: string;
  orderCode: string;
  itemId: string;
  instrumentId: string;
}
const allocCache = new Map<string, Promise<AllocationScene>>();

export function allocationScene(app: pg.Pool, ownerId: string, marker: string): Promise<AllocationScene> {
  let made = allocCache.get(marker);
  if (!made) {
    made = (async () => {
      const master = await orderMaster(app, ownerId, marker);
      return withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
        const client = await tx.query<{ id: string }>(
          `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
          [`al${marker}`],
        );
        const clientId = client.rows[0]?.id as string;
        const order = await insertOrder(tx, ownerId, { ...master, clientId });
        const item = await tx.query<{ id: string }>(`select id from payment_plan_item where order_id = $1`, [
          order.id,
        ]);
        const instrument = await insertInstrument(tx, ownerId, { clientId, amountCentimes: 936_000 });
        return {
          clientId,
          orderId: order.id,
          orderCode: order.code,
          itemId: item.rows[0]?.id as string,
          instrumentId: instrument.id,
        };
      });
    })();
    allocCache.set(marker, made);
  }
  return made;
}

/** An order of 9 360,00 TTC split into the given item amounts (centimes, summing to 936 000), for a given client. */
export async function insertOrderWithItems(
  tx: pg.PoolClient,
  actorId: string,
  master: OrderMaster,
  clientId: string,
  items: number[],
  options: { zoneId?: string; volumeL?: number; methods?: string[] } = {},
): Promise<{ id: string; code: string; itemIds: string[] }> {
  const id = randomUUID();
  const code = (await tx.query<{ n: string }>(`select public.next_doc_number('CMD', 2026, 5) as n`)).rows[0]
    ?.n as string;
  await tx.query(
    `insert into sales_order (id, code, client_id, zone_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                              unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
     values ($1, $2, $3, $8, $4, $9, '2026-06-01', '2026-06-02', $5, $6, 2000, 780000, 156000, 936000, $7)`,
    [
      id,
      code,
      clientId,
      master.typeId,
      master.sellingPriceId,
      master.unitPriceCentimes,
      actorId,
      options.zoneId ?? null,
      options.volumeL ?? 10000,
    ],
  );
  const itemIds: string[] = [];
  for (const [n, amount] of items.entries()) {
    const itemId = randomUUID();
    itemIds.push(itemId);
    await tx.query(
      `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
       values ($1, $2, $3, 'in', $7, $4, $5, $6)`,
      [itemId, id, n + 1, `2026-07-0${n + 1}`, amount, actorId, options.methods?.[n] ?? 'cheque'],
    );
  }
  return { id, code, itemIds };
}

/** The opening date is a singleton shared by the whole test database: whoever needs it first enters it (2026-01-01). */
export function ensureOpening(app: pg.Pool, ownerId: string, marker: string) {
  return withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, (tx) =>
    tx.query(
      `insert into ledger_opening (opening_date, created_by) values ('2026-01-01', $1) on conflict do nothing`,
      [ownerId],
    ),
  );
}

/** An order of 10 m³ for a client of its own, a truck (the pilot's T1), and a recette in force from 2000 with cement and sand lines. */
export interface DeliveryScene {
  clientId: string;
  orderId: string;
  typeId: string;
  truckId: string;
  recetteId: string;
  cementId: string;
  sandId: string;
}
const deliveryCache = new Map<string, Promise<DeliveryScene>>();

export function deliveryScene(
  app: pg.Pool,
  ownerId: string,
  marker: string,
  /** The order's delivery date (default 2026-06-02). */
  deliveryDate?: string,
): Promise<DeliveryScene> {
  let made = deliveryCache.get(marker);
  if (!made) {
    made = (async () => {
      const master = await orderMaster(app, ownerId, marker);
      return withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
        const client = await tx.query<{ id: string }>(
          `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
          [`dl${marker}`],
        );
        const clientId = client.rows[0]?.id as string;
        const order = await insertOrder(tx, ownerId, { ...master, clientId }, deliveryDate);
        const truck = await tx.query<{ id: string }>(`select id from truck where code = 'T1'`);
        const recette = await tx.query<{ id: string }>(
          `insert into recette (id, concrete_type_id, version, effective_from, created_by)
           values (gen_random_uuid(), $1, 1, '2000-01-01', $2) returning id`,
          [master.typeId, ownerId],
        );
        const components = await tx.query<{ id: string; name: string }>(
          `select id, lower(name_fr) as name from component where lower(name_fr) in ('ciment', 'sable')`,
        );
        const cementId = components.rows.find((c) => c.name === 'ciment')?.id as string;
        const sandId = components.rows.find((c) => c.name === 'sable')?.id as string;
        for (const [componentId, qty] of [
          [cementId, 350_000],
          [sandId, 800_000],
        ] as const) {
          await tx.query(
            `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, $2, $3)`,
            [recette.rows[0]?.id, componentId, qty],
          );
        }
        return {
          clientId,
          orderId: order.id,
          typeId: master.typeId,
          truckId: truck.rows[0]?.id as string,
          recetteId: recette.rows[0]?.id as string,
          cementId,
          sandId,
        };
      });
    })();
    deliveryCache.set(marker, made);
  }
  return made;
}

/** A delivery of `volumeL` litres written directly (the actor must be allowed to load: owner, partner or plant). */
export async function insertDelivery(
  tx: pg.PoolClient,
  actorId: string,
  scene: Pick<DeliveryScene, 'orderId' | 'truckId' | 'recetteId'>,
  volumeL = 1000,
  year = 2026,
  /** The moment of loading (a timestamp); now() when absent. Fixtures use it as a marker the matrix can find them by. */
  loadedAt: string | null = null,
): Promise<{ id: string; blNo: string }> {
  const id = randomUUID();
  const blNo = (await tx.query<{ n: string }>(`select public.next_doc_number('BL', $1, 5) as n`, [year]))
    .rows[0]?.n as string;
  await tx.query(
    `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, loaded_at, recette_id, created_by)
     values ($1, $2, $3, $4, $5, '2026-06-01', coalesce($8::timestamptz, now()), $6, $7)`,
    [id, blNo, scene.orderId, scene.truckId, volumeL, scene.recetteId, actorId, loadedAt],
  );
  // The stock the load takes out, from the recette in force (what the service does), or the commit is refused.
  const lines = await tx.query<{ component_id: string; qty_per_m3: string }>(
    `select component_id, qty_per_m3::text from recette_line where recette_id = $1`,
    [scene.recetteId],
  );
  for (const q of consumptionForLoad(
    lines.rows.map((l) => ({ componentId: l.component_id, qtyPerM3: Number(l.qty_per_m3) })),
    volumeL,
  ).filter((x) => x.qtyBase !== 0)) {
    await tx.query(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
       values (gen_random_uuid(), $1, '2026-06-01', $2, 'delivery', $3, $4)`,
      [q.componentId, -q.qtyBase, id, actorId],
    );
  }
  return { id, blNo };
}

/** A delivery by the owner in a context of its own (for fixtures that insert the return as someone else). */
export function newDelivery(
  app: pg.Pool,
  ownerId: string,
  marker: string,
  scene: DeliveryScene,
  volumeL = 100,
  year = 2026,
) {
  return withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, (tx) =>
    insertDelivery(tx, ownerId, scene, volumeL, year),
  );
}

/** Master data a purchase needs: an active supplier, a component with a purchase unit (1 t = 1 000 000 g). Once per marker, by the owner. */
export interface PurchaseMaster {
  supplierId: string;
  componentId: string;
  unitId: string;
}
const purchaseCache = new Map<string, Promise<PurchaseMaster>>();

export function purchaseMaster(app: pg.Pool, ownerId: string, marker: string): Promise<PurchaseMaster> {
  let made = purchaseCache.get(marker);
  if (!made) {
    made = withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
      const supplier = await tx.query<{ id: string }>(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
        [`ps${marker}`],
      );
      const component = await tx.query<{ id: string }>(
        `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g') returning id`,
        [`ps${marker}`],
      );
      const unit = await tx.query<{ id: string }>(
        `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 't', 1000000) returning id`,
        [component.rows[0]?.id],
      );
      return {
        supplierId: supplier.rows[0]?.id as string,
        componentId: component.rows[0]?.id as string,
        unitId: unit.rows[0]?.id as string,
      };
    });
    purchaseCache.set(marker, made);
  }
  return made;
}

/**
 * Inserts one purchase of 30 t at 1 450,00 per t (HT 43 500,00, VAT 20 % 8 700,00, TTC 52 200,00) with one plan item, the
 * way the service does: number from next_doc_number, no RETURNING. Run it inside the actor's transaction.
 */
export async function insertPurchase(
  tx: pg.PoolClient,
  actorId: string,
  master: PurchaseMaster,
  opts: { orderDate?: string; dueDate?: string } = {},
): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = (await tx.query<{ n: string }>(`select public.next_doc_number('ACH', 2026, 5) as n`)).rows[0]
    ?.n as string;
  const orderDate = opts.orderDate ?? '2026-06-01';
  const dueDate = opts.dueDate ?? '2026-07-31';
  await tx.query(
    `insert into purchase (id, code, supplier_id, order_date, due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes,
                           total_ttc_centimes, created_by)
     values ($1, $2, $3, $4, $5, 2000, 4350000, 870000, 5220000, $6)`,
    [id, code, master.supplierId, orderDate, dueDate, actorId],
  );
  await tx.query(
    `insert into purchase_line (id, purchase_id, seq, component_id, purchase_unit_id, qty_milli, unit_price_ht_centimes,
                                line_ht_centimes, created_by)
     values (gen_random_uuid(), $1, 1, $2, $3, 30000, 145000, 4350000, $4)`,
    [id, master.componentId, master.unitId, actorId],
  );
  await tx.query(
    `insert into purchase_plan_item (id, purchase_id, seq, method, due_date, amount_centimes, created_by)
     values (gen_random_uuid(), $1, 1, 'transfer', $2, 5220000, $3)`,
    [id, dueDate, actorId],
  );
  return { id, code };
}

/**
 * A fresh purchase (30 t of the master's component) nobody has received yet, made by the owner for a supplier of its own
 * (`rc<marker>`), so that fixtures counting the master supplier's purchases are not disturbed.
 */
export async function newReceivablePurchase(
  app: pg.Pool,
  ownerId: string,
  master: PurchaseMaster,
  marker: string,
): Promise<{ id: string; code: string }> {
  return withRlsContext(app, { userId: ownerId, role: 'owner', requestId: marker }, async (tx) => {
    const supplier = await tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
      [`rc${marker}${randomUUID().slice(0, 8)}`],
    );
    return insertPurchase(tx, ownerId, { ...master, supplierId: supplier.rows[0]?.id as string });
  });
}

/**
 * Invoices one load of the delivery scene's order (unit price 780,00 per m³, VAT 2000 bp), the way the service does: number
 * from next_doc_number, no RETURNING. For `volumeL` = 50: line HT 39,00, VAT 7,80, TTC 46,80. Run it inside the actor's
 * transaction; the load must be that of `delivery`.
 */
export async function insertInvoice(
  tx: pg.PoolClient,
  actorId: string,
  scene: Pick<DeliveryScene, 'orderId' | 'clientId'>,
  delivery: { id: string; blNo: string },
  clientName: string,
  volumeL = 50,
): Promise<{ id: string; number: string }> {
  const id = randomUUID();
  const number = (await tx.query<{ n: string }>(`select public.next_doc_number('FA', 2026, 5) as n`)).rows[0]
    ?.n as string;
  const ht = Math.round((78_000 * volumeL) / 1000);
  const vat = Math.round((ht * 2000) / 10_000);
  // Only a delivered load is billed (D97): the fixture's load is delivered if nobody did it yet.
  await tx.query(
    `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by)
     values (gen_random_uuid(), $1, now(), null, $2) on conflict (delivery_id) do nothing`,
    [delivery.id, actorId],
  );
  await tx.query(
    `insert into invoice (id, number, order_id, client_id, client_name, invoice_date, issue_deadline, due_date, vat_rate_bp,
                          total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
     values ($1, $2, $3, $4, $5, '2026-06-02', '2026-06-30', '2026-08-01', 2000, $6, $7, $8, $9)`,
    [id, number, scene.orderId, scene.clientId, clientName, ht, vat, ht + vat, actorId],
  );
  await tx.query(
    `insert into invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes, line_ht_centimes, created_by)
     values (gen_random_uuid(), $1, 1, $2, $3, $4, 78000, $5, $6)`,
    [id, delivery.id, `BL ${delivery.blNo}`, volumeL, ht, actorId],
  );
  return { id, number };
}

/**
 * Inserts one quote of 10 m³ at the master's list price (780,00 per m³, VAT 2000 bp: HT 7 800,00, VAT 1 560,00, TTC 9 360,00)
 * the way the service does: number from next_doc_number, no RETURNING. Run it inside the actor's transaction.
 */
export async function insertQuote(
  tx: pg.PoolClient,
  actorId: string,
  master: OrderMaster,
): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = (await tx.query<{ n: string }>(`select public.next_doc_number('DV', 2026, 5) as n`)).rows[0]
    ?.n as string;
  await tx.query(
    `insert into quote (id, code, client_id, concrete_type_id, volume_l, quote_date, valid_until, selling_price_id,
                        unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
     values ($1, $2, $3, $4, 10000, '2026-06-01', '2026-07-01', $5, $6, 2000, 780000, 156000, 936000, $7)`,
    [id, code, master.clientId, master.typeId, master.sellingPriceId, master.unitPriceCentimes, actorId],
  );
  return { id, code };
}

/**
 * A client who paid an advance on an order (the first plan item, method `advance`, covered by a cheque) and had a load of
 * `loadL` litres delivered; the invoice is made from that load by the database function, as the owner. Run it inside the
 * owner's transaction. The client is named `adv<marker>`.
 */
export async function newAdvanceInvoice(
  tx: pg.PoolClient,
  ownerId: string,
  master: OrderMaster,
  scene: Pick<DeliveryScene, 'truckId' | 'recetteId'>,
  marker: string,
  options: { advanceCentimes?: number; loadL?: number; today?: string } = {},
): Promise<{
  number: string | null;
  clientId: string;
  orderId: string;
  deliveryId: string;
  advanceCentimes: number;
}> {
  const advance = Math.min(options.advanceCentimes ?? 280_800, 936_000);
  const client = await tx.query<{ id: string }>(
    `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
    [`adv${marker}`],
  );
  const clientId = client.rows[0]?.id as string;
  const whole = advance >= 936_000;
  const order = await insertOrderWithItems(
    tx,
    ownerId,
    master,
    clientId,
    whole ? [936_000] : [advance, 936_000 - advance],
    { methods: ['advance', 'installment'] },
  );
  const instrument = await insertInstrument(tx, ownerId, { clientId, amountCentimes: advance });
  await tx.query(
    `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`,
    [instrument.id, order.itemIds[0], advance, ownerId],
  );
  const delivery = await insertDelivery(
    tx,
    ownerId,
    { ...scene, orderId: order.id },
    options.loadL ?? 6000,
    2026,
  );
  await tx.query(
    `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values (gen_random_uuid(), $1, now(), null, $2)`,
    [delivery.id, ownerId],
  );
  const made = await tx.query<{ n: string | null }>(
    `select public.create_invoice_from_deliveries(ARRAY[$1]::uuid[], null, $2::date) as n`,
    [delivery.id, options.today ?? '2026-06-10'],
  );
  return {
    number: made.rows[0]?.n ?? null,
    clientId,
    orderId: order.id,
    deliveryId: delivery.id,
    advanceCentimes: advance,
  };
}
