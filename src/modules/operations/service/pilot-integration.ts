import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import {
  addDaysIso,
  insertOrderRows,
  insertPurchaseRows,
  type OrderInput,
  prepareOrder,
  purchaseDueDate,
} from '@/modules/ledger';
import { assertSeedAllowed, type SeedGuardEnv } from '@/modules/master-data';
import { SYSTEM_ACTOR_ID, type SessionUser } from '@/modules/platform-security';
import { insertLoadRows, recetteInForce } from './delivery-service';
import { confirmArrivalIfPlants } from './pilot-ops';

type Tx = pg.PoolClient;

const system = { id: SYSTEM_ACTOR_ID } as SessionUser;
const CLIENT_NAME = 'Chantier Intégration (fictif)';

export interface IntegrationScenarioResult {
  applied: boolean;
  loads: number;
  invoices: number;
  payments: number;
  supplierInvoices: number;
}

const NOTHING: IntegrationScenarioResult = {
  applied: false,
  loads: 0,
  invoices: 0,
  payments: 0,
  supplierInvoices: 0,
};

/** The answer of a door that returns nothing when it refuses: say why from the audit log, never carry on silently. */
async function must<T>(tx: Tx, what: string, value: T | null | undefined): Promise<T> {
  if (value !== null && value !== undefined && value !== false) return value;
  const why = await tx.query<{ table_name: string; reason: string | null }>(
    `select table_name, reason from audit_event where action = 'permission_denied' order by id desc limit 1`,
  );
  throw new Error(
    `Integration scenario: ${what} was refused (${why.rows[0]?.reason ?? 'no reason audited'})`,
  );
}

async function account(tx: Tx, label: string): Promise<string> {
  const r = await tx.query<{ id: string }>(`select id from money_account where lower(label) = lower($1)`, [
    label,
  ]);
  if (!r.rows[0])
    throw new Error(`Integration scenario: account ${label} missing (run the pilot scenario first)`);
  return r.rows[0].id;
}

interface InstrumentSpec {
  direction: 'in' | 'out';
  method: 'transfer' | 'cheque';
  amountCentimes: number | string;
  clientId?: string;
  supplierId?: string;
  number: string;
  date: string;
}

/** A payment instrument with its first event (received or issued); amounts may come from SQL as text so that nothing is added here. */
async function newInstrument(tx: Tx, s: InstrumentSpec): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into payment_instrument (id, direction, method, amount_centimes, client_id, supplier_id, number, bank, written_date, received_date, created_by)
     values ($1, $2, $3, $4::bigint, $5, $6, $7, 'Banque Atlas (fictive)', case when $3 = 'cheque' then $8::date end, $8, $9)`,
    [
      id,
      s.direction,
      s.method,
      s.amountCentimes,
      s.clientId ?? null,
      s.supplierId ?? null,
      s.number,
      s.date,
      SYSTEM_ACTOR_ID,
    ],
  );
  await instrumentEvent(tx, id, s.direction === 'in' ? 'received' : 'issued', s.date, null);
  return id;
}

async function instrumentEvent(
  tx: Tx,
  instrumentId: string,
  event: 'received' | 'issued' | 'deposited' | 'cleared' | 'bounced',
  date: string,
  accountId: string | null,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, created_by) values ($1, $2, $3, $4, $5, $6)`,
    [id, instrumentId, event, date, accountId, SYSTEM_ACTOR_ID],
  );
  return id;
}

async function cell(tx: Tx, sql: string, params: unknown[] = []): Promise<string | null> {
  return (await tx.query<{ v: string | null }>(sql, params)).rows[0]?.v ?? null;
}

/**
 * The sales chain, walked once for a demo (AC-INT-23): three orders for one client, two of them planned in rotations (one
 * on its truck's default driver, one overridden with a reason), loaded (BL), delivered (by the unloading step, or by hand),
 * signed back (not all), invoiced from the BLs with an advance, a cheque allocated oldest due first across the open invoices,
 * a second cheque that bounces and reopens its invoice. The statement of the client shows it all.
 */
async function walkSales(
  tx: Tx,
  today: string,
): Promise<{ loads: number; invoices: number; payments: number }> {
  const bank = await account(tx, 'Compte courant Banque Atlas (fictif)');
  const client = (
    await tx.query<{ id: string; code: string }>(
      `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'company') returning id, code`,
      [CLIENT_NAME],
    )
  ).rows[0] as { id: string; code: string };
  const type = (await tx.query<{ id: string }>(`select id from concrete_type where code = 'B25'`)).rows[0];
  if (!type) throw new Error('Integration scenario: concrete type B25 missing (run db:seed)');

  const orderDay = addDaysIso(today, -14);
  const order = async (
    volumeM3: number,
    deliveryDate: string,
    preset: 'cash' | 'advance50' | 'installments3',
  ) => {
    const input: OrderInput = {
      clientId: client.id,
      siteId: null,
      zoneId: null,
      concreteTypeId: type.id,
      dischargeMethod: 'GOULOTTE',
      volumeL: volumeM3 * 1000,
      deliveryDate,
      broughtByUserId: null,
      plan: { preset },
    };
    const prepared = await prepareOrder(tx, input, orderDay);
    if (!prepared.ok) throw new Error(`Integration scenario: order refused (${prepared.error})`);
    return insertOrderRows(tx, system, input, prepared.value, orderDay);
  };
  const dayA = addDaysIso(today, -10);
  const dayB = addDaysIso(today, -9);
  const dayC = addDaysIso(today, -8);
  const A = await order(16, dayA, 'advance50');
  const B = await order(8, dayB, 'cash');
  const C = await order(8, dayC, 'installments3');

  // Default drivers: the first trucks by code take the first drivers by code (only where a truck has none yet).
  const trucks = (
    await tx.query<{ id: string; default_driver_id: string | null }>(
      `select id, default_driver_id from truck where status = 'active' order by code`,
    )
  ).rows;
  const drivers = (
    await tx.query<{ id: string }>(`select id from driver where status = 'active' order by code`)
  ).rows;
  for (const [i, t] of trucks.entries()) {
    const d = drivers[i];
    if (d && !t.default_driver_id) {
      await tx.query(`update truck set default_driver_id = $2 where id = $1`, [t.id, d.id]);
      t.default_driver_id = d.id;
    }
  }
  const [t1, t2] = trucks as [(typeof trucks)[number], (typeof trucks)[number]];
  if (!t1 || !t2) throw new Error('Integration scenario: needs two active trucks (run db:seed)');
  const swap = drivers.find((d) => d.id !== t2.default_driver_id)?.id ?? null;

  // Order A, planned in two rotations: the first on its truck's default driver, the second overridden with a reason.
  const batch = randomUUID();
  const rotation = async (seq: number, truckId: string, driverId: string | null, reason: string | null) => {
    const shift = (seq - 1) * 120;
    const id = randomUUID();
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min,
                              arrive_min, unload_end_min, back_min, created_by, driver_override_reason)
       values ($1, $2, $3, $4, $5, $6, $7, 8000, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        batch,
        dayA,
        A.id,
        seq,
        truckId,
        driverId,
        420 + shift,
        430 + shift,
        455 + shift,
        485 + shift,
        520 + shift,
        SYSTEM_ACTOR_ID,
        reason,
      ],
    );
    return id;
  };
  const r1 = await rotation(1, t1.id, t1.default_driver_id, null);
  const r2 = await rotation(
    2,
    t2.id,
    t2.default_driver_id ? swap : null,
    t2.default_driver_id ? 'Chauffeur habituel absent (démonstration)' : null,
  );

  const recette = async (date: string) => {
    const id = await recetteInForce(tx, type.id, date);
    if (!id) throw new Error(`Integration scenario: no recette in force for ${date}`);
    return id;
  };
  const load = async (orderId: string, truckId: string, date: string, hour: number) =>
    insertLoadRows(tx, system, {
      orderId,
      truckId,
      volumeL: 8000,
      date,
      recetteId: await recette(date),
      loadedAt: `${date}T${String(hour).padStart(2, '0')}:00:00Z`,
    });
  const A1 = await load(A.id, t1.id, dayA, 7);
  const A2 = await load(A.id, t2.id, dayA, 9);
  const B1 = await load(B.id, t1.id, dayB, 7);
  const C1 = await load(C.id, t1.id, dayC, 7);

  // A's rotations are tracked to the end: the unloading step delivers each BL (AC-INT-01).
  const steps = ['loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'] as const;
  const offsets = [0, 10, 35, 40, 70, 100];
  for (const [trip, bl, hour] of [
    [r1, A1, 7],
    [r2, A2, 9],
  ] as const) {
    for (const [i, step] of steps.entries()) {
      const minutes = hour * 60 + (offsets[i] as number);
      const at = `${dayA}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`;
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), trip, step, at, step === 'loaded' ? bl.id : null, SYSTEM_ACTOR_ID],
      );
    }
  }
  // B and C went out without a rotation: delivered by hand.
  for (const [bl, date] of [
    [B1, dayB],
    [C1, dayC],
  ] as const) {
    await tx.query(
      `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by, via) values ($1, $2, $3::timestamptz + interval '100 minutes', null, $4, 'hand')`,
      [randomUUID(), bl.id, `${date}T07:00:00Z`, SYSTEM_ACTOR_ID],
    );
  }
  // The signed BL is back for A1 and B1; A2 and C1 are still out (the demo shows them as not signed).
  for (const [bl, date] of [
    [A1, dayA],
    [B1, dayB],
  ] as const) {
    await tx.query(
      `insert into delivery_return (id, delivery_id, returned_on, returned_volume_l, created_by) values ($1, $2, $3, 0, $4)`,
      [randomUUID(), bl.id, addDaysIso(date, 1), SYSTEM_ACTOR_ID],
    );
  }

  // The advance of order A (half of it, by transfer, cleared at the bank) is allocated to its advance item.
  const advanceItem = await must(
    tx,
    'the advance item',
    await cell(tx, `select id::text as v from payment_plan_item where order_id = $1 and method = 'advance'`, [
      A.id,
    ]),
  );
  const advance = await newInstrument(tx, {
    direction: 'in',
    method: 'transfer',
    amountCentimes: await must(
      tx,
      'the advance amount',
      await cell(tx, `select amount_centimes::text as v from payment_plan_item where id = $1`, [advanceItem]),
    ),
    clientId: client.id,
    number: 'VIR-INT-001',
    date: addDaysIso(orderDay, 1),
  });
  await tx.query(
    `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by)
     select gen_random_uuid(), $1, $2, amount_centimes, $3 from payment_plan_item where id = $2`,
    [advance, advanceItem, SYSTEM_ACTOR_ID],
  );
  await instrumentEvent(tx, advance, 'cleared', addDaysIso(orderDay, 1), bank);

  // One invoice from three BLs of two orders (the advance of A is applied once), another from the third order's BL.
  const invoice1 = await must(
    tx,
    'invoice 1',
    await cell(tx, `select public.create_invoice_from_deliveries($1::uuid[], null, $2::date) as v`, [
      [A1.id, A2.id, B1.id],
      addDaysIso(today, -7),
    ]),
  );
  const invoice2 = await must(
    tx,
    'invoice 2',
    await cell(tx, `select public.create_invoice_from_deliveries($1::uuid[], null, $2::date) as v`, [
      [C1.id],
      addDaysIso(today, -6),
    ]),
  );

  // A cheque that covers the first invoice's net and 3 000,00 of the second: allocated oldest due first, in one action.
  const cheque1 = await newInstrument(tx, {
    direction: 'in',
    method: 'cheque',
    amountCentimes: await must(
      tx,
      'cheque 1 amount',
      await cell(
        tx,
        `select (i.total_ttc_centimes - (select p.amount_centimes from payment_plan_item p where p.id = $2) + 300000)::text as v from invoice i where i.number = $1`,
        [invoice1, advanceItem],
      ),
    ),
    clientId: client.id,
    number: 'CHQ-INT-001',
    date: addDaysIso(today, -5),
  });
  await must(
    tx,
    'the allocation of cheque 1',
    await cell(tx, `select public.allocate_to_client($1::uuid, $2) as v`, [cheque1, client.code]),
  );
  await instrumentEvent(tx, cheque1, 'deposited', addDaysIso(today, -4), bank);
  await instrumentEvent(tx, cheque1, 'cleared', addDaysIso(today, -2), bank);

  // A second cheque for the rest of the second invoice: deposited, then it bounces; the bounce reverses its allocations (the
  // invoice is open again) and the 30-day window to regularize starts.
  const cheque2 = await newInstrument(tx, {
    direction: 'in',
    method: 'cheque',
    amountCentimes: await must(
      tx,
      'cheque 2 amount',
      await cell(tx, `select (i.total_ttc_centimes - 300000)::text as v from invoice i where i.number = $1`, [
        invoice2,
      ]),
    ),
    clientId: client.id,
    number: 'CHQ-INT-002',
    date: addDaysIso(today, -4),
  });
  await must(
    tx,
    'the allocation of cheque 2',
    await cell(tx, `select public.allocate_to_client($1::uuid, $2) as v`, [cheque2, client.code]),
  );
  await instrumentEvent(tx, cheque2, 'deposited', addDaysIso(today, -3), bank);
  const bounceDate = addDaysIso(today, -1);
  const bounced = await instrumentEvent(tx, cheque2, 'bounced', bounceDate, null);
  await tx.query(
    `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, reverses_id, reason, invoice_id, created_by)
     select gen_random_uuid(), a.instrument_id, a.payment_plan_item_id, -a.amount_centimes, a.id, 'chèque ou LCN rejeté', a.invoice_id, $2
       from allocation a where a.instrument_id = $1 and a.reverses_id is null`,
    [cheque2, SYSTEM_ACTOR_ID],
  );
  await tx.query(
    `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, reason, created_by)
     values (gen_random_uuid(), $1, -15000, $2, 'expense', $3, 'frais de rejet', $4)`,
    [bank, bounceDate, bounced, SYSTEM_ACTOR_ID],
  );
  return { loads: 4, invoices: 2, payments: 3 };
}

/**
 * The purchase chain, walked once for a demo (AC-INT-23): a purchase order for cement, a partial receipt, the supplier's
 * invoice for the whole order at a price a little above ours (two flags: quantity beyond what was received, price above the
 * order), the owner accepts the gaps with a reason, approves it (the payable is created from the invoice), and it is paid.
 */
async function walkPurchases(tx: Tx, today: string): Promise<number> {
  const bank = await account(tx, 'Compte courant Banque Atlas (fictif)');
  const offer = (
    await tx.query<{ supplier_id: string; component_id: string; purchase_unit_id: string; price: string }>(
      `select p.supplier_id, l.component_id, l.purchase_unit_id, l.unit_price_ht_centimes::text as price
         from purchase p join purchase_line l on l.purchase_id = p.id join supplier s on s.id = p.supplier_id
        where s.category = 'cement' and p.reverses_id is null and l.purchase_unit_id is not null
        order by p.order_date desc, p.code desc limit 1`,
    )
  ).rows[0];
  if (!offer)
    throw new Error('Integration scenario: no earlier cement purchase to copy the supplier and price from');
  const orderDay = addDaysIso(today, -12);
  const due = purchaseDueDate(orderDay, orderDay, null);
  if (!due.ok) throw new Error(due.error);
  const created = await insertPurchaseRows(
    tx,
    system,
    {
      supplierId: offer.supplier_id,
      payable: 'invoice',
      lines: [
        {
          componentId: offer.component_id,
          purchaseUnitId: offer.purchase_unit_id,
          qtyMilli: 30_000,
          unitPriceHtCentimes: Number(offer.price),
        },
      ],
      plan: null,
    },
    due.value,
    orderDay,
  );
  if (!created.ok) throw new Error(`Integration scenario: purchase refused (${created.error})`);
  const line = await must(
    tx,
    'the purchase line',
    await cell(tx, `select id::text as v from purchase_line where purchase_id = $1`, [created.value.id]),
  );
  // 18 of the 30 units arrive first.
  await confirmArrivalIfPlants(tx, created.value.id);
  await must(
    tx,
    'the partial receipt',
    await cell(tx, `select public.record_receipt_lines($1::uuid, $2::date, $3::jsonb, false)::text as v`, [
      created.value.id,
      addDaysIso(today, -9),
      JSON.stringify([{ lineId: line, qtyMilli: 18_000 }]),
    ]),
  );
  // The supplier bills all 30 at 3 % above the order's price (rounded once, whole centimes).
  const billed = await must(
    tx,
    'the billed price',
    await cell(tx, `select ((($1::bigint) * 103 + 50) / 100)::text as v`, [offer.price]),
  );
  const code = await must(
    tx,
    'the supplier invoice',
    await cell(
      tx,
      `select public.create_supplier_invoice($1, $2, $3::date, null, $4::jsonb, null, $5::date) as v`,
      [
        created.value.code,
        'FS-DEMO-0001',
        addDaysIso(today, -7),
        JSON.stringify([
          { componentId: offer.component_id, qtyMilli: 30_000, unitPriceHtCentimes: Number(billed) },
        ]),
        addDaysIso(today, -7),
      ],
    ),
  );
  const si = await must(
    tx,
    'the supplier invoice id',
    await cell(tx, `select id::text as v from supplier_invoice where code = $1`, [code]),
  );
  await must(
    tx,
    'the acceptance of the gaps',
    await cell(tx, `select public.accept_supplier_invoice_gaps($1::uuid, $2) as v`, [
      si,
      'Prix du jour du fournisseur accepté, reliquat attendu (démonstration)',
    ]),
  );
  await must(
    tx,
    'the approval',
    await cell(tx, `select public.approve_supplier_invoice($1::uuid, null) as v`, [si]),
  );
  // Payment by transfer of the invoice's total, allocated to the supplier invoice by its code.
  const pay = await newInstrument(tx, {
    direction: 'out',
    method: 'transfer',
    amountCentimes: await must(
      tx,
      'the amount to pay',
      await cell(tx, `select total_ttc_centimes::text as v from supplier_invoice where id = $1`, [si]),
    ),
    supplierId: offer.supplier_id,
    number: 'VIR-FRN-INT-001',
    date: addDaysIso(today, -3),
  });
  await must(
    tx,
    'the supplier payment allocation',
    await cell(tx, `select public.allocate_to_supplier_invoice($1::uuid, $2) as v`, [pay, code]),
  );
  await instrumentEvent(tx, pay, 'cleared', addDaysIso(today, -3), bank);
  return 1;
}

/**
 * The integration walk (AC-INT-23, fake data only, decision 79): the chains of CP-INTEGRATION-2 seeded in the states a demo
 * wants to show, relative to `today`. Runs as the seed role with the system request context; every row is audited and every
 * door is the one the application uses. Idempotent by its client's name; it needs the pilot scenario first.
 */
export async function seedIntegrationScenario(
  seedPool: pg.Pool,
  env: SeedGuardEnv,
  today: string,
): Promise<IntegrationScenarioResult> {
  assertSeedAllowed(env);
  return withRlsContext(
    seedPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'seed-scenario-integration' },
    async (tx): Promise<IntegrationScenarioResult> => {
      if (!(await cell(tx, `select 1::text as v from ledger_opening`))) return NOTHING;
      if (await cell(tx, `select id::text as v from client where name = $1`, [CLIENT_NAME])) return NOTHING;
      const sales = await walkSales(tx, today);
      const supplierInvoices = await walkPurchases(tx, today);
      return { applied: true, ...sales, supplierInvoices };
    },
  );
}
