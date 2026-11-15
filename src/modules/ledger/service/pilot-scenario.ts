import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { assertSeedAllowed, type SeedGuardEnv } from '@/modules/master-data';
import { SYSTEM_ACTOR_ID, type SessionUser } from '@/modules/platform-security';
import { addDaysIso } from '../domain/dates';
import type { OrderInput } from '../domain/order';
import {
  type AccountRef,
  createRng,
  type InstrumentPlan,
  planClientPayments,
  planSupplierPayments,
  type Rng,
  type ScenarioItem,
  type SupplierRef,
} from '../domain/scenario';
import { insertOrderRows, prepareOrder } from './order-service';

type Tx = Parameters<Parameters<typeof withRlsContext>[2]>[0];

const SEED = 20_261_024;
const DAYS = 90;
const system = { id: SYSTEM_ACTOR_ID } as SessionUser;

/** 20 more clients (the master data seed has 5): fake names, all marked "fictif". */
const EXTRA_CLIENTS: [string, 'company' | 'person'][] = [
  ['Entreprise Tazi Construction (fictif)', 'company'],
  ['Société Rif Béton Services (fictif)', 'company'],
  ['Promotion Cap Spartel Immobilier (fictif)', 'company'],
  ['Groupe Andalous Travaux (fictif)', 'company'],
  ['Bennani Travaux Publics (fictif)', 'company'],
  ['Coopérative Habitat Martil (fictif)', 'company'],
  ['SARL Fnideq Bâtiment (fictif)', 'company'],
  ['Entreprise El Idrissi & Fils (fictif)', 'company'],
  ['Résidence Les Oliviers Promotion (fictif)', 'company'],
  ['Mohamed Ouazzani Test (fictif)', 'person'],
  ['Atlas Préfabriqués Nord (fictif)', 'company'],
  ['Société Jbel Dersa Terrassement (fictif)', 'company'],
  ['Hassan Chraibi Test (fictif)', 'person'],
  ['Tanger Med Sous-Traitance (fictif)', 'company'],
  ['Association Écoles du Nord (fictif)', 'company'],
  ['Entreprise Benabdellah Génie Civil (fictif)', 'company'],
  ['Immo Khmiss Construction (fictif)', 'company'],
  ['Société Oued Martil Béton (fictif)', 'company'],
  ['Fatima Alaoui Test (fictif)', 'person'],
  ['Menuiserie et Bâtiment Ghazaoua (fictif)', 'company'],
];

/** 3 more suppliers (the master data seed has 5): transport, a second quarry, small supplies. */
const EXTRA_SUPPLIERS: [string, string][] = [
  ['Transports Tétouan Logistique (fictif)', 'transport'],
  ['Carrière Oued Laou Sable (fictif)', 'aggregates'],
  ['Quincaillerie Industrielle Nord (fictif)', 'other'],
];

const ZONES = ['Tétouan centre', 'Martil', "M'diq", 'Fnideq', 'Oued Laou'];
const VOLUMES_M3 = [8, 16, 24, 32, 40, 60, 80, 120, 150];

interface Accounts {
  caisse: string;
  bank1: string;
  bank2: string;
}

function pickWeighted(rng: Rng, n: number): number {
  const weights = Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, 0.7));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (const [i, w] of weights.entries()) {
    r -= w;
    if (r <= 0) return i;
  }
  return n - 1;
}

const isWorkingDay = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 0;

/** The clients and suppliers of a plant of this size, on top of the master data seed. Idempotent by name. */
async function seedParties(tx: Tx): Promise<void> {
  for (const [i, [name, kind]] of EXTRA_CLIENTS.entries()) {
    await tx.query(
      `insert into client (id, code, name, kind, default_zone_id)
       select gen_random_uuid(), public.next_code('CLT', 3), $1, $2, (select id from zone where name = $3)
        where not exists (select 1 from client where lower(name) = lower($1))`,
      [name, kind, ZONES[i % ZONES.length]],
    );
  }
  for (const [name, category] of EXTRA_SUPPLIERS) {
    await tx.query(
      `insert into supplier (id, code, name, category)
       select gen_random_uuid(), public.next_code('FRN', 2), $1, $2
        where not exists (select 1 from supplier where lower(name) = lower($1))`,
      [name, category],
    );
  }
}

async function seedAccounts(tx: Tx): Promise<Accounts> {
  const make = async (kind: 'cash' | 'bank', label: string, bankName: string | null) => {
    const found = await tx.query<{ id: string }>(
      `select id from money_account where lower(label) = lower($1)`,
      [label],
    );
    if (found.rows[0]) return found.rows[0].id;
    const id = randomUUID();
    await tx.query(
      `insert into money_account (id, kind, label, bank_name, created_by) values ($1, $2, $3, $4, $5)`,
      [id, kind, label, bankName, SYSTEM_ACTOR_ID],
    );
    return id;
  };
  return {
    caisse: await make('cash', 'Caisse principale (fictif)', null),
    bank1: await make('bank', 'Compte courant Banque Atlas (fictif)', 'Banque Atlas (fictive)'),
    bank2: await make('bank', 'Compte courant Banque du Rif (fictif)', 'Banque du Rif (fictive)'),
  };
}

/** Orders over the last three months: past ones delivered and being paid, the latest ones delivering in the next two weeks. */
async function seedOrders(tx: Tx, today: string, openingDate: string, rng: Rng): Promise<ScenarioItem[]> {
  const clients = (
    await tx.query<{ id: string }>(`select id from client where status = 'active' order by code`)
  ).rows;
  const types = (
    await tx.query<{ id: string; code: string }>(
      `select id, code from concrete_type where code in ('B20','B25','B30')`,
    )
  ).rows;
  const typeId = (code: string) => types.find((t) => t.code === code)?.id as string;
  const presets = [
    'cash',
    'advance50',
    'installments3',
    'cheque30',
    'cash',
    'advance50',
    'cheque30',
  ] as const;

  for (let d = addDaysIso(openingDate, 1); d <= today; d = addDaysIso(d, 1)) {
    if (!isWorkingDay(d)) continue;
    const roll = rng.next();
    const count = roll < 0.15 ? 0 : roll < 0.6 ? 1 : roll < 0.9 ? 2 : 3;
    for (let n = 0; n < count; n++) {
      const clientIndex = pickWeighted(rng, clients.length);
      const volumeM3 = rng.pick(VOLUMES_M3);
      const typeRoll = rng.next();
      const typeCode = typeRoll < 0.35 ? 'B20' : typeRoll < 0.8 ? 'B25' : 'B30';
      const recent = d >= addDaysIso(today, -4);
      const deliveryDate = addDaysIso(d, recent ? rng.int(2, 14) : rng.int(0, 5));
      const big = volumeM3 >= 80 && rng.next() < 0.35;
      const plan: OrderInput['plan'] = big
        ? {
            preset: 'custom',
            items: [30, 60, 90].map((days, i) => ({
              method: 'lcn' as const,
              dueDate: addDaysIso(deliveryDate, days),
              percentBp: i === 2 ? 3334 : 3333,
            })),
          }
        : { preset: presets[clientIndex % presets.length] as 'cash' };
      const input: OrderInput = {
        clientId: (clients[clientIndex] as { id: string }).id,
        siteId: null,
        zoneId: null,
        concreteTypeId: typeId(typeCode),
        // fictitious scenario data: no pump job exists in the scenario, so every order is a chute order (a POMPE BL without a pump job is flagged, D243)
        dischargeMethod: 'GOULOTTE',
        volumeL: volumeM3 * 1000,
        deliveryDate,
        broughtByUserId: null,
        plan,
      };
      const prepared = await prepareOrder(tx, input, d);
      if (!prepared.ok) throw new Error(`Scenario order refused (${prepared.error}) on ${d}`);
      await insertOrderRows(tx, system, input, prepared.value, d);
    }
  }
  const rows = await tx.query<{
    id: string;
    order_id: string;
    client_id: string;
    method: ScenarioItem['method'];
    due: string;
    amount: string;
    order_date: string;
  }>(
    `select i.id, i.order_id, o.client_id, i.method, to_char(i.due_date, 'YYYY-MM-DD') as due,
            i.amount_centimes::text as amount, to_char(o.order_date, 'YYYY-MM-DD') as order_date
       from payment_plan_item i join sales_order o on o.id = i.order_id
      where o.reverses_id is null order by o.order_date, o.code, i.seq`,
  );
  return rows.rows.map((r) => ({
    itemId: r.id,
    orderId: r.order_id,
    clientId: r.client_id,
    method: r.method,
    dueDate: r.due,
    amountCentimes: Number(r.amount),
    orderDate: r.order_date,
  }));
}

async function writeInstrument(
  tx: Tx,
  plan: InstrumentPlan,
  accounts: Accounts,
  written: Map<string, string>,
  byKey: Map<string, InstrumentPlan>,
): Promise<void> {
  if (written.has(plan.key)) return;
  const id = randomUUID();
  written.set(plan.key, id);
  await tx.query(
    `insert into payment_instrument (id, direction, method, amount_centimes, client_id, supplier_id, number, bank, written_date, received_date, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      plan.direction,
      plan.method,
      plan.amountCentimes,
      plan.clientId ?? null,
      plan.supplierId ?? null,
      plan.number,
      plan.bank,
      plan.writtenDate,
      plan.receivedDate,
      SYSTEM_ACTOR_ID,
    ],
  );
  const event = async (
    name: string,
    date: string,
    account: AccountRef | undefined,
    extra: { reason?: string; covering?: string } = {},
  ) => {
    await tx.query(
      `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, reason, covering_instrument_id, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        name,
        date,
        account ? accounts[account] : null,
        extra.reason ?? null,
        extra.covering ?? null,
        SYSTEM_ACTOR_ID,
      ],
    );
  };
  await event(plan.direction === 'in' ? 'received' : 'issued', plan.receivedDate, undefined);
  if (plan.method === 'cash') await event('cleared', plan.receivedDate, 'caisse');
  let allocationId: string | null = null;
  if (plan.allocateItemId) {
    allocationId = randomUUID();
    await tx.query(
      `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by) values ($1, $2, $3, $4, $5)`,
      [allocationId, id, plan.allocateItemId, plan.amountCentimes, SYSTEM_ACTOR_ID],
    );
  }
  for (const e of plan.events) {
    if (e.event === 'regularized') {
      const cover = byKey.get(e.coveringKey as string) as InstrumentPlan;
      await writeInstrument(tx, cover, accounts, written, byKey);
      await event('regularized', e.date, undefined, { covering: written.get(cover.key) });
      continue;
    }
    await event(e.event, e.date, e.account, { reason: e.reason });
    if (e.event === 'bounced') {
      if (allocationId) {
        await tx.query(
          `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, reverses_id, reason, created_by)
           values (gen_random_uuid(), $1, $2, $3, $4, 'chèque ou LCN rejeté', $5)`,
          [id, plan.allocateItemId, -plan.amountCentimes, allocationId, SYSTEM_ACTOR_ID],
        );
      }
      const deposited = plan.events.find((x) => x.event === 'deposited');
      if (e.feeCentimes && deposited?.account) {
        await tx.query(
          `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, reason, created_by)
           values (gen_random_uuid(), $1, $2, $3, 'expense', gen_random_uuid(), 'frais de rejet', $4)`,
          [accounts[deposited.account], -e.feeCentimes, e.date, SYSTEM_ACTOR_ID],
        );
      }
    }
  }
}

async function writeInstruments(
  tx: Tx,
  plans: readonly InstrumentPlan[],
  accounts: Accounts,
  written: Map<string, string>,
): Promise<void> {
  const byKey = new Map(plans.map((p) => [p.key, p]));
  for (const p of plans) await writeInstrument(tx, p, accounts, written, byKey);
}

const sum = async (tx: Tx, sql: string, params: unknown[] = []) =>
  Number((await tx.query<{ s: string | null }>(sql, params)).rows[0]?.s ?? 0);

export interface ScenarioResult {
  applied: boolean;
  today: string;
  openingDate: string;
  orders: number;
  instruments: number;
}

/**
 * The pilot scenario (decision 79, fake data only): a mid-size Tetouan plant three months into its activity, dated
 * relative to `today` (the simulation clock when it runs, else the real date). Runs as the seed role with the system
 * request context, every row audited. Idempotent: it does nothing once the opening date exists. See domain/scenario.ts
 * for the stories (cheques in every state, instalments, a tight day) and tasks/todo-ledger.md L34 for what later tasks add.
 */
export async function seedPilotScenario(
  seedPool: pg.Pool,
  env: SeedGuardEnv,
  today: string,
): Promise<ScenarioResult> {
  assertSeedAllowed(env);
  const openingDate = addDaysIso(today, -DAYS);
  return withRlsContext(
    seedPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'seed-scenario' },
    async (tx): Promise<ScenarioResult> => {
      const done = await tx.query(`select 1 from ledger_opening`);
      if (done.rows.length > 0) return { applied: false, today, openingDate, orders: 0, instruments: 0 };
      const masters = await tx.query<{ n: string }>(`select count(*)::text as n from client`);
      if (Number(masters.rows[0]?.n) < 5)
        throw new Error('Run the master data seed first (corepack pnpm db:seed)');

      const rng = createRng(SEED);
      await seedParties(tx);
      await tx.query(`insert into ledger_opening (opening_date, created_by) values ($1, $2)`, [
        openingDate,
        SYSTEM_ACTOR_ID,
      ]);
      const accounts = await seedAccounts(tx);

      // What some clients and suppliers owed on the opening date.
      const owing = await tx.query<{ id: string }>(
        `select id from client where status = 'active' order by code limit 6`,
      );
      for (const c of owing.rows) {
        await tx.query(
          `insert into opening_party_balance (id, client_id, amount_centimes, reference, created_by) values (gen_random_uuid(), $1, $2, 'Solde repris à l''ouverture (fictif)', $3)`,
          [c.id, rng.int(800_000, 4_500_000), SYSTEM_ACTOR_ID],
        );
      }
      const suppliers = (
        await tx.query<{ id: string; category: SupplierRef['category'] }>(
          `select id, category from supplier where status = 'active' order by code`,
        )
      ).rows;
      for (const s of suppliers
        .filter((x) => ['cement', 'aggregates', 'transport'].includes(x.category))
        .slice(0, 3)) {
        await tx.query(
          `insert into opening_party_balance (id, supplier_id, amount_centimes, reference, created_by) values (gen_random_uuid(), $1, $2, 'Solde repris à l''ouverture (fictif)', $3)`,
          [s.id, rng.int(1_500_000, 12_000_000), SYSTEM_ACTOR_ID],
        );
      }

      const items = await seedOrders(tx, today, openingDate, rng);
      const orders = new Set(items.map((i) => i.orderId)).size;
      const written = new Map<string, string>();
      const clientPlans = planClientPayments(items, today, rng);
      await writeInstruments(tx, clientPlans, accounts, written);

      // Suppliers: the history and the cheques issued for the next two weeks, the cement one sized below.
      const supplierSeed = rng.int(1, 1_000_000);
      const placeholder = { availableCentimes: 0, shortfallCentimes: 0 };
      const supplierPlans = planSupplierPayments(
        suppliers,
        today,
        openingDate,
        createRng(supplierSeed),
        placeholder,
      );
      const tightPlan = supplierPlans.find((p) => p.story === 'tight-day');
      await writeInstruments(
        tx,
        supplierPlans.filter((p) => p !== tightPlan),
        accounts,
        written,
      );

      // Opening balances of the three accounts: the banks are set so that today's real cash is about 600 000 MAD.
      const movements = await sum(tx, `select sum(amount_centimes)::text as s from money_movement`);
      const caisseOpening = 6_000_000;
      const bank2Opening = 35_000_000;
      const bank1Opening = 60_000_000 - movements - caisseOpening - bank2Opening;
      for (const [id, amount, note] of [
        [accounts.caisse, caisseOpening, "Fonds de caisse à l'ouverture (fictif)"],
        [accounts.bank1, bank1Opening, "Solde bancaire à l'ouverture (fictif)"],
        [accounts.bank2, bank2Opening, "Solde bancaire à l'ouverture (fictif)"],
      ] as const) {
        await tx.query(
          `insert into opening_balance (id, account_id, as_of, amount_centimes, note, created_by) values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [id, openingDate, amount, note, SYSTEM_ACTOR_ID],
        );
      }

      // One tight day: the cement cheque written for day +6 exceeds what the accounts hold plus what the portfolio brings by 40 000 MAD.
      const horizon = addDaysIso(today, 6);
      const portfolio = await sum(
        tx,
        `select sum(i.amount_centimes)::text as s from payment_instrument i
           cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
          where i.direction = 'in' and i.method in ('cheque', 'lcn') and last.event in ('received', 'deposited') and i.written_date <= $1`,
        [horizon],
      );
      const issuedBefore = await sum(
        tx,
        `select sum(i.amount_centimes)::text as s from payment_instrument i
           cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
          where i.direction = 'out' and last.event = 'issued' and i.written_date <= $1`,
        [horizon],
      );
      const real = 60_000_000;
      const available = real + portfolio - issuedBefore;
      if (tightPlan) {
        const amount = Math.max(5_000_000, Math.round((available + 4_000_000) / 10_000) * 10_000);
        await writeInstruments(tx, [{ ...tightPlan, amountCentimes: amount }], accounts, written);
      }
      return { applied: true, today, openingDate, orders, instruments: written.size };
    },
  );
}
