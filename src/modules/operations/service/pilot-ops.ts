import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import {
  addDaysIso,
  createRng,
  insertCreditNoteRows,
  insertInvoiceRows,
  insertPurchaseRows,
  invoiceDueDate,
  purchaseDueDate,
  type Rng,
} from '@/modules/ledger';
import { assertSeedAllowed, type SeedGuardEnv } from '@/modules/master-data';
import { SYSTEM_ACTOR_ID, type SessionUser } from '@/modules/platform-security';
import { insertLoadRows, recetteInForce } from './delivery-service';

type Tx = pg.PoolClient;

const SEED = 20_261_025;
const system = { id: SYSTEM_ACTOR_ID } as SessionUser;
const CHUNKS = 12;

export interface OpsScenarioResult {
  applied: boolean;
  loads: number;
  returns: number;
  purchases: number;
  receipts: number;
  invoices: number;
}

const NOTHING: OpsScenarioResult = {
  applied: false,
  loads: 0,
  returns: 0,
  purchases: 0,
  receipts: 0,
  invoices: 0,
};

interface ComponentRow {
  id: string;
  name_fr: string;
  base_unit: string;
}

/**
 * Loads for the orders delivered so far: each order goes out in truck-sized loads on its delivery date (those due in the last
 * three days are half loaded), most signed delivery notes are back. Stock, BL numbers and the recette in force come from the same
 * code as the plant's own action (`insertLoadRows`).
 */
async function seedLoads(tx: Tx, today: string, rng: Rng): Promise<{ loads: number; returns: number }> {
  const trucks = (
    await tx.query<{ id: string; capacity_l: number }>(
      `select id, capacity_l from truck where status = 'active' order by code`,
    )
  ).rows;
  if (trucks.length === 0)
    throw new Error('No active truck: run the master data seed first (corepack pnpm db:seed)');
  const orders = (
    await tx.query<{
      id: string;
      concrete_type_id: string;
      volume_l: number;
      delivery_date: string;
      plant_id: string | null;
    }>(
      `select o.id, o.concrete_type_id, o.volume_l, o.plant_id, to_char(o.delivery_date, 'YYYY-MM-DD') as delivery_date
         from sales_order o
        where o.reverses_id is null and o.delivery_date <= $1
          and not exists (select 1 from sales_order r where r.reverses_id = o.id)
        order by o.delivery_date, o.code`,
      [today],
    )
  ).rows;
  let loads = 0;
  let returns = 0;
  const perDay = new Map<string, number>();
  for (const o of orders) {
    const recetteId = await recetteInForce(tx, o.concrete_type_id, o.delivery_date, o.plant_id);
    if (!recetteId) throw new Error(`No recette in force for ${o.delivery_date}`);
    let left = o.volume_l;
    const sizes: number[] = [];
    let n = 0;
    while (left > 0) {
      const capacity = (trucks[n % trucks.length] as { capacity_l: number }).capacity_l;
      const size = Math.min(left, capacity);
      sizes.push(size);
      left -= size;
      n += 1;
    }
    // The last three days are still being loaded: a big order has its first half out, a one-truck order is waiting for the
    // plant (so the loads screen has something to load, and the stock has moved less than it will).
    const todo =
      o.delivery_date >= addDaysIso(today, -3) ? sizes.slice(0, Math.floor(sizes.length / 2)) : sizes;
    for (const [i, size] of todo.entries()) {
      const slot = perDay.get(o.delivery_date) ?? 0;
      perDay.set(o.delivery_date, slot + 1);
      const minutes = 6 * 60 + ((slot * 17) % (11 * 60));
      const loadedAt = `${o.delivery_date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`;
      const truck = trucks[(i + slot) % trucks.length] as { id: string };
      const load = await insertLoadRows(tx, system, {
        orderId: o.id,
        truckId: truck.id,
        volumeL: size,
        date: o.delivery_date,
        recetteId,
        loadedAt,
      });
      loads += 1;
      // A load older than the tracked fortnight was delivered, 100 minutes after it left; the tracked rotations of the last
      // fortnight (second wave) deliver theirs through their unloading step.
      if (o.delivery_date < addDaysIso(today, -14)) {
        await tx.query(
          `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values ($1, $2, $3::timestamptz + interval '100 minutes', null, $4)`,
          [randomUUID(), load.id, loadedAt, SYSTEM_ACTOR_ID],
        );
      }
      // The signed delivery note comes back within a day or two for most loads older than two days.
      if (o.delivery_date <= addDaysIso(today, -2) && rng.next() < 0.92) {
        const back = addDaysIso(o.delivery_date, rng.int(0, 1));
        const unused = rng.next() < 0.05 ? rng.int(1, 8) * 100 : 0;
        await tx.query(
          `insert into delivery_return (id, delivery_id, returned_on, returned_volume_l, created_by) values ($1, $2, $3, $4, $5)`,
          [randomUUID(), load.id, back, unused, SYSTEM_ACTOR_ID],
        );
        returns += 1;
      }
    }
  }
  return { loads, returns };
}

/**
 * Stock around the loads: opening stock, a threshold per component, and purchases received through the year so that
 * cement ends below its threshold (low), one gravel just above it, and the rest comfortably over.
 */
async function seedStockAndPurchases(
  tx: Tx,
  today: string,
  openingDate: string,
  rng: Rng,
): Promise<{ purchases: number; receipts: number }> {
  const components = (
    await tx.query<ComponentRow>(
      `select id, name_fr, base_unit from component where status = 'active' order by code`,
    )
  ).rows;
  const consumed = new Map(
    (
      await tx.query<{ component_id: string; c: string }>(
        `select component_id, (-sum(qty_base))::text as c from stock_movement where source = 'delivery' group by 1`,
      )
    ).rows.map((r) => [r.component_id, Number(r.c)]),
  );
  // Buying terms: the purchase unit and price of each component (the pilot price list), and the supplier who sells it.
  const offers = new Map(
    (
      await tx.query<{
        component_id: string;
        supplier_id: string;
        purchase_unit_id: string;
        price: string;
        factor: number;
        label: string;
      }>(
        `select distinct on (p.component_id) p.component_id, p.supplier_id, p.purchase_unit_id, p.price_ht_centimes::text as price,
                u.factor_to_base as factor, u.label
           from purchase_price p join purchase_unit u on u.id = p.purchase_unit_id
          order by p.component_id, p.effective_from desc, p.id`,
      )
    ).rows.map((r) => [r.component_id, r]),
  );

  let purchases = 0;
  let receipts = 0;
  const lastDay = addDaysIso(today, -3);
  const span = Math.max(CHUNKS, 80);
  for (const c of components) {
    const used = consumed.get(c.id) ?? 0;
    const offer = offers.get(c.id);
    if (used <= 0 || !offer) continue;
    const threshold = Math.max(1000, Math.round(used / 12 / 1000) * 1000);
    const targetEnd =
      c.name_fr === 'Ciment'
        ? Math.round(threshold * 0.8)
        : c.name_fr === 'Gravette 15/25'
          ? Math.round(threshold * 1.15)
          : threshold * 3;
    const opening = Math.round((used * 0.25) / 1000) * 1000;
    await tx.query(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
       values ($1, $2, $3, $4, 'opening', $2, $5)`,
      [randomUUID(), c.id, openingDate, opening, SYSTEM_ACTOR_ID],
    );
    await tx.query(
      `insert into stock_threshold (id, component_id, low_qty_base, created_by) values ($1, $2, $3, $4)`,
      [randomUUID(), c.id, threshold, SYSTEM_ACTOR_ID],
    );

    // The days purchases are made (the goods come in two days later, never after today).
    const days: string[] = [];
    for (let k = 0; k < CHUNKS; k++) {
      const date = addDaysIso(openingDate, 4 + Math.floor(((span - 8) * k) / CHUNKS) + rng.int(0, 2));
      if (date <= lastDay && addDaysIso(date, 2) <= today) days.push(date);
    }
    if (days.length === 0) continue;
    // What has to come in so that opening + receipts - consumption = the target at the end. One chunk is `qtyMilli`
    // thousandths of the purchase unit: whole base units whatever the unit (kg of a tonne, L of a m³).
    const needed = Math.max(0, used - opening + targetEnd);
    const perChunkMilli = Math.max(1, Math.round(needed / days.length / (offer.factor / 1000)));
    const buy = async (date: string, receive: boolean) => {
      const split = rng.next() < 0.5;
      const due = purchaseDueDate(date, date, null);
      if (!due.ok) throw new Error(due.error);
      const created = await insertPurchaseRows(
        tx,
        system,
        {
          supplierId: offer.supplier_id,
          supplierInvoiceNo: `F-${date.slice(2, 4)}${date.slice(5, 7)}-${String(100 + purchases)}`,
          supplierInvoiceDate: date,
          payable: 'order',
          lines: [
            {
              componentId: c.id,
              purchaseUnitId: offer.purchase_unit_id,
              qtyMilli: perChunkMilli,
              unitPriceHtCentimes: Number(offer.price),
            },
          ],
          plan: split
            ? [
                { method: 'cheque', dueDate: addDaysIso(date, 30), percentBp: 5000 },
                { method: 'cheque', dueDate: addDaysIso(date, 60), percentBp: 5000 },
              ]
            : null,
        },
        due.value,
        date,
      );
      if (!created.ok) throw new Error(`Scenario purchase refused (${created.error}) on ${date}`);
      purchases += 1;
      if (receive) {
        await confirmArrivalIfPlants(tx, created.value.id);
        await tx.query('select public.record_receipt($1, $2)', [created.value.id, addDaysIso(date, 2)]);
        receipts += 1;
      }
    };
    for (const date of days) await buy(date, true);
    // One more cement order is on its way: the receipts screen has something to receive.
    if (c.name_fr === 'Ciment') await buy(addDaysIso(today, -1), false);
  }

  // Services (transport, fuel): payables with no stock effect.
  const providers = (
    await tx.query<{ id: string; category: string }>(
      `select id, category from supplier where category in ('transport', 'other', 'fuel') and status = 'active' order by code limit 3`,
    )
  ).rows;
  for (const [i, s] of providers.entries()) {
    for (let m = 0; m < 3; m++) {
      const date = addDaysIso(openingDate, 20 + m * 30 + i * 3);
      if (date > lastDay) continue;
      const due = purchaseDueDate(date, date, null);
      if (!due.ok) throw new Error(due.error);
      const created = await insertPurchaseRows(
        tx,
        system,
        {
          supplierId: s.id,
          supplierInvoiceNo: `S-${date.slice(2, 4)}${date.slice(5, 7)}-${i}`,
          supplierInvoiceDate: date,
          payable: 'order',
          lines: [
            {
              description:
                s.category === 'transport'
                  ? 'Transport de granulats (fictif)'
                  : 'Gasoil et entretien (fictif)',
              qtyMilli: 1000,
              unitPriceHtCentimes: rng.int(180_000, 950_000),
            },
          ],
          plan: null,
        },
        due.value,
        date,
      );
      if (!created.ok) throw new Error(`Scenario service purchase refused (${created.error}) on ${date}`);
      purchases += 1;
    }
  }
  return { purchases, receipts };
}

/**
 * The payments to suppliers the scenario already holds (cheques and transfers issued, most of them cleared) are put against
 * what each supplier is owed, oldest due date first: some purchases end paid, some part-paid, the recent ones open.
 */
async function seedSupplierPayments(tx: Tx): Promise<number> {
  const instruments = (
    await tx.query<{ id: string; supplier_id: string; amount: string }>(
      `select i.id, i.supplier_id, i.amount_centimes::text as amount
         from payment_instrument i
         cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
        where i.direction = 'out' and last.event in ('issued', 'cleared') and i.supplier_id is not null
        order by i.supplier_id, i.received_date, i.id`,
    )
  ).rows;
  let made = 0;
  const items = new Map<string, { id: string; open: number }[]>();
  for (const inst of instruments) {
    let list = items.get(inst.supplier_id);
    if (!list) {
      const rows = await tx.query<{ id: string; open: string }>(
        `select i.id, (i.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.purchase_plan_item_id = i.id), 0))::text as open
           from purchase_plan_item i join purchase p on p.id = i.purchase_id
          where p.supplier_id = $1 and i.reverses_id is null and p.reverses_id is null
            and not exists (select 1 from purchase r where r.reverses_id = p.id)
          order by i.due_date, i.id`,
        [inst.supplier_id],
      );
      list = rows.rows.map((r) => ({ id: r.id, open: Number(r.open) }));
      items.set(inst.supplier_id, list);
    }
    let left = Number(inst.amount);
    for (const item of list) {
      if (left <= 0) break;
      if (item.open <= 0) continue;
      const take = Math.min(left, item.open);
      await tx.query(
        `insert into allocation (id, instrument_id, purchase_plan_item_id, amount_centimes, created_by) values ($1, $2, $3, $4, $5)`,
        [randomUUID(), inst.id, item.id, take, SYSTEM_ACTOR_ID],
      );
      item.open -= take;
      left -= take;
      made += 1;
    }
  }
  return made;
}

/** Invoices for the orders whose loads are all out, a few days after the last load; one of them cancelled by a credit note. */
async function seedInvoices(tx: Tx, today: string, rng: Rng): Promise<number> {
  const orders = (
    await tx.query<{ id: string; code: string; last_load: string }>(
      `select o.id, o.code, to_char(max(d.load_date), 'YYYY-MM-DD') as last_load
         from sales_order o join delivery d on d.order_id = o.id and d.reverses_id is null
        where o.reverses_id is null
        group by o.id, o.code, o.volume_l
       having sum(d.volume_l) = o.volume_l and max(d.load_date) <= $1::date - 4
          and bool_and(exists (select 1 from delivery_delivered g where g.delivery_id = d.id))
        order by max(d.load_date), o.code`,
      [today],
    )
  ).rows;
  let made = 0;
  const invoices: string[] = [];
  for (const o of orders) {
    if (rng.next() < 0.06) continue;
    // Usually within days, sometimes after the end of the delivery month (issued late: law 69-21 flags it).
    const date = addDaysIso(o.last_load, rng.int(0, 5) + (rng.next() < 0.1 ? 20 : 0));
    const invoiceDate = date > today ? today : date;
    const due = invoiceDueDate(invoiceDate, null);
    if (!due.ok) throw new Error(due.error);
    const r = await insertInvoiceRows(tx, system, { orderCode: o.code }, due.value, invoiceDate);
    if (!r.ok) throw new Error(`Scenario invoice refused (${r.error}) for ${o.code}`);
    invoices.push(r.value.id);
    made += 1;
  }
  const credited = invoices[3];
  if (credited) {
    const r = await insertCreditNoteRows(
      tx,
      system,
      credited,
      'Erreur de prix, facture annulée (fictif)',
      addDaysIso(today, -6),
    );
    if (!r.ok) throw new Error(`Scenario credit note refused (${r.error})`);
  }
  return made;
}

/**
 * With a plant active a receipt needs the plant's confirmation first (D133). The pilot scenario (and the training seed, which runs it
 * with a plant active) stands for the plant: it confirms the arrival, then the office step follows. No plant: nothing to do.
 */
export async function confirmArrivalIfPlants(
  tx: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  purchaseId: string,
): Promise<void> {
  await tx.query(
    `select public.confirm_receipt_at_plant($1, null) where exists (select 1 from public.plant where status = 'active')`,
    [purchaseId],
  );
}

/**
 * The operations part of the pilot scenario (operations O8, fake data only): loads and signed delivery notes for the orders
 * delivered so far, opening stock, thresholds, purchases received into the stock (one still expected), invoices and a
 * credit note. Runs after `seedPilotScenario` as the seed role, every row audited as system/seed. Idempotent: nothing is
 * written once a load or an opening stock exists.
 */
export async function seedOperationsScenario(
  seedPool: pg.Pool,
  env: SeedGuardEnv,
  today: string,
): Promise<OpsScenarioResult> {
  assertSeedAllowed(env);
  return withRlsContext(
    seedPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'seed-scenario-ops' },
    async (tx): Promise<OpsScenarioResult> => {
      const opening = await tx.query<{ d: string }>(
        `select to_char(opening_date, 'YYYY-MM-DD') as d from ledger_opening`,
      );
      if (!opening.rows[0]) throw new Error('Run the ledger scenario first (corepack pnpm db:scenario)');
      // Our own (fake) legal identity, so that the documents print with their mentions. Independent of the rest.
      const hasCompany = await tx.query('select 1 from company_profile limit 1');
      if (hasCompany.rows.length === 0) {
        await tx.query(
          `insert into company_profile (id, effective_from, legal_name, legal_form, ice, if_number, rc_number, patente, address,
                                        phone, email, rib, created_by)
           values ($1, $2, 'KAYAS PILOTE (fictif)', 'SARL', '001234567000089', '12345678', 'TET-45678', '98765432',
                   'Zone industrielle, Tétouan (fictif)', '+212 5 39 00 00 00', 'contact@kayas.test', '181780000012345678901234', $3)`,
          [randomUUID(), opening.rows[0].d, SYSTEM_ACTOR_ID],
        );
      }
      const done = await tx.query(
        `select 1 from delivery union all select 1 from stock_movement where source = 'opening' limit 1`,
      );
      if (done.rows.length > 0) return NOTHING;
      const rng = createRng(SEED);
      const { loads, returns } = await seedLoads(tx, today, rng);
      const { purchases, receipts } = await seedStockAndPurchases(tx, today, opening.rows[0].d, rng);
      await seedSupplierPayments(tx);
      const invoices = await seedInvoices(tx, today, rng);
      return { applied: true, loads, returns, purchases, receipts, invoices };
    },
  );
}
