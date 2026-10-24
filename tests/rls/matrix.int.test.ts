import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_ROLES, withRlsContext } from '../../src/lib/db/rls-context';
import { RLS_TABLES, TABLE_ACCESS } from '../../src/modules/platform-security/domain/table-access';
import { testEnv } from '../db-env';
import { realActor } from '../helpers/actors';
import {
  allocationScene,
  deliveryScene,
  insertDelivery,
  newDelivery,
  ensureOpening,
  insertInstrument,
  insertMovementReversal,
  insertInvoice,
  insertOrder,
  insertPurchase,
  moneyMaster,
  newReceivablePurchase,
  newCashMovement,
  orderMaster,
  purchaseMaster,
} from '../helpers/ledger-fixtures';
import { resetSimClock } from '../helpers/reset-sim-clock';
import { ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID } from '../../src/modules/platform-security/auth/actors';
import { USER_ROLES } from '../../src/modules/platform-security/domain/permissions';

// AC-SEC-04, generated from the registry: for every RLS table × every role, read exactly what the matrix allows.
type DbRole = (typeof DB_ROLES)[number];
type RlsTable = (typeof RLS_TABLES)[number];

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(async () => {
  await resetSimClock();
  await Promise.all([app.end(), system.end()]);
});

const marker = `matrix_${randomUUID().replace(/-/g, '')}`;
// One actor per role: real accounts for user roles, the fixed actors otherwise (the database checks roles, DECISIONS 76).
const actors = {} as Record<DbRole, string>;

/**
 * Per table: which roles can write seed rows, how to write one for an actor, and a query returning the actor
 * (`owner` column) of each visible seeded row.
 */
const FIXTURES: Record<
  RlsTable,
  {
    writers: readonly DbRole[];
    /** Database role that writes the seed rows (default belgobeton_app). */
    pool?: 'system';
    seed: (tx: pg.PoolClient, actor: string) => Promise<unknown>;
    visible: string;
    /** `visible` also takes $2: every actor id as text[] (for tables with no column roomy enough for an actor id). */
    withActors?: true;
  }
> = {
  audit_event: {
    writers: DB_ROLES,
    seed: (tx) => tx.query(`select audit.record('export', 'matrix', null, null, null, $1)`, [marker]),
    visible: `select actor_user_id::text as owner from audit_event where reason = $1`,
  },
  parameter: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(`insert into parameter (key, value, updated_by, updated_at) values ($1, '1', $2, now())`, [
        `test.${marker}`,
        actor,
      ]),
    visible: `select updated_by::text as owner from parameter where key = 'test.' || $1`,
  },
  security_checklist_item: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into security_checklist_item (key, status, evidence, checked_by, checked_at) values ($1, 'done', 'x', $2, now())`,
        [`test_${marker}`, actor],
      ),
    visible: `select checked_by::text as owner from security_checklist_item where key = 'test_' || $1`,
  },
  security_check_run: {
    // Failed runs: they must not count as a recent successful restore test for other suites.
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(
        `insert into security_check_run (key, ok, at, detail) values ('restore_test', false, now(), $1)`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(detail, ':', 2) as owner from security_check_run where detail like $1 || ':%'`,
  },
  security_alert: {
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', now(), $1)`, [
        `${marker}:${actor}`,
      ]),
    visible: `select split_part(detail, ':', 2) as owner from security_alert where detail like $1 || ':%'`,
  },
  sim_clock: {
    // Singleton: seeded in 'real' mode so other suites never see a simulated instant.
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(
        `insert into sim_clock (mode, sim_now, updated_by, updated_at) values ('real', now(), $1, now())
         on conflict do nothing`,
        [actor],
      ),
    visible: `select updated_by::text as owner from sim_clock where $1::text is not null`,
  },
  scheduled_job_run: {
    writers: ['system'],
    pool: 'system',
    seed: (tx, actor) =>
      tx.query(
        `insert into scheduled_job_run (id, job_key, business_date, status, ran_at, run_by)
         values (gen_random_uuid(), $1, '2000-01-01', 'succeeded', now(), $2)`,
        [`matrix-${marker.slice(-12)}`, actor],
      ),
    visible: `select run_by::text as owner from scheduled_job_run where job_key = 'matrix-' || right($1, 12)`,
  },
  zone: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 10)`, [
        `${marker}:${actor}`,
      ]),
    visible: `select split_part(name, ':', 2) as owner from zone where name like $1 || ':%'`,
  },
  code_sequence: {
    // One counter per writer role, keyed by the role so the visible query can name its actor. Persistent by design.
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) => {
      const role = Object.entries(actors).find(([, id]) => id === actor)![0];
      return tx.query(
        `insert into code_sequence (key, last_value) values ($1, 0) on conflict (key) do nothing`,
        [{ owner: 'MXO', partner: 'MXP', office: 'MXF' }[role as 'owner' | 'partner' | 'office']],
      );
    },
    get visible() {
      return `select case key when 'MXO' then '${actors.owner}' when 'MXP' then '${actors.partner}'
                               when 'MXF' then '${actors.office}' end as owner
                from code_sequence where key like 'MX_' and $1::text is not null`;
    },
  },
  correction_request: {
    writers: ['owner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into correction_request (id, document_code, reason, requested_by)
         values (gen_random_uuid(), 'CMD-2026-00001', $1, $2)`,
        [`${marker}:${actor}`, actor],
      ),
    visible: `select split_part(reason, ':', 2) as owner from correction_request where reason like $1 || ':%'`,
  },
  money_account: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into money_account (id, kind, label, created_by) values (gen_random_uuid(), 'cash', $1, $2)`,
        [`${marker}:${actor}`, actor],
      ),
    visible: `select split_part(label, ':', 2) as owner from money_account where label like $1 || ':%'`,
  },
  opening_balance: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `with a as (select id from money_account where label = $1)
         insert into opening_balance (id, account_id, as_of, amount_centimes, created_by)
         select gen_random_uuid(), id, '2026-01-01', 100, $2 from a`,
        [`${marker}:${actor}`, actor],
      ),
    visible: `select b.created_by::text as owner from opening_balance b join money_account a on a.id = b.account_id
               where a.label like $1 || ':%'`,
  },
  payment_instrument: {
    writers: ['owner', 'office'],
    seed: async (tx, actor) => {
      await moneyMaster(app, actors.owner, marker);
      return insertInstrument(tx, actor, {
        clientId: (await orderMaster(app, actors.owner, marker)).clientId,
      });
    },
    visible: `select i.created_by::text as owner from payment_instrument i join client c on c.id = i.client_id
               where c.name = 'fx' || $1 and i.method = 'cheque'`,
  },
  instrument_event: {
    // The first event is written with its instrument by the same actors (seeded by the fixture above).
    writers: ['owner', 'office'],
    seed: async () => undefined,
    visible: `select e.created_by::text as owner from instrument_event e join payment_instrument i on i.id = e.instrument_id
                join client c on c.id = i.client_id where c.name = 'fx' || $1 and i.method = 'cheque'`,
  },
  money_movement: {
    // Rows come from the definer trigger on a clearing; the only direct insert is the owner's reversal.
    writers: ['owner'],
    seed: async (tx, actor) => {
      await moneyMaster(app, actors.owner, marker);
      const original = await newCashMovement(
        app,
        actors.owner,
        marker,
        (await orderMaster(app, actors.owner, marker)).clientId,
      );
      return insertMovementReversal(tx, actor, original, `${marker}:${actor}`);
    },
    visible: `select split_part(reason, ':', 2) as owner from money_movement where source = 'reversal' and reason like $1 || ':%'`,
  },
  delivery: {
    // Numbered in the year 2099 so that the rows of this fixture are the only ones the query below finds (office cannot join orders).
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) =>
      insertDelivery(tx, actor, await deliveryScene(app, actors.owner, marker), 100, 2099),
    visible: `select created_by::text as owner from delivery where bl_no like 'BL-2099-%' and $1::text is not null`,
  },
  delivery_return: {
    // One return per delivery: each writer gets a delivery of its own (year 2098), made by the owner.
    writers: ['owner', 'partner', 'office', 'plant'],
    seed: async (tx, actor) => {
      const delivery = await newDelivery(
        app,
        actors.owner,
        marker,
        await deliveryScene(app, actors.owner, marker),
        50,
        2098,
      );
      return tx.query(
        `insert into delivery_return (id, delivery_id, returned_on, created_by) values (gen_random_uuid(), $1, '2026-06-01', $2)`,
        [delivery.id, actor],
      );
    },
    visible: `select r.created_by::text as owner from delivery_return r join delivery d on d.id = r.delivery_id
                where d.bl_no like 'BL-2098-%' and $1::text is not null`,
  },
  stock_movement: {
    // Written with a load (plant, owner, partner); numbered in 2097 so the query finds only these, one cement movement each.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) =>
      insertDelivery(tx, actor, await deliveryScene(app, actors.owner, marker), 77, 2097),
    visible: `select m.created_by::text as owner from stock_movement m join delivery d on d.id = m.source_id
                where d.bl_no like 'BL-2097-%' and m.component_id = (select id from component where lower(name_fr) = 'ciment')
                  and $1::text is not null`,
  },
  ledger_opening: {
    // A singleton: the first writer enters it, later inserts do nothing. The others are refused by the policy.
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into ledger_opening (opening_date, created_by) values ('2026-01-01', $1) on conflict do nothing`,
        [actor],
      ),
    visible: `select created_by::text as owner from ledger_opening where $1::text is not null`,
  },
  opening_party_balance: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      await ensureOpening(app, actors.owner, marker);
      return tx.query(
        `insert into opening_party_balance (id, client_id, amount_centimes, created_by) values (gen_random_uuid(), $1, 100, $2)`,
        [(await orderMaster(app, actors.owner, marker)).clientId, actor],
      );
    },
    visible: `select b.created_by::text as owner from opening_party_balance b join client c on c.id = b.client_id
                where c.name = 'fx' || $1`,
  },
  allocation: {
    // Office covers orders only through allocate_to_order; the direct insert is the owner's.
    writers: ['owner'],
    seed: async (tx, actor) => {
      const scene = await allocationScene(app, actors.owner, marker);
      return tx.query(
        `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by)
         values (gen_random_uuid(), $1, $2, 100, $3)`,
        [scene.instrumentId, scene.itemId, actor],
      );
    },
    visible: `select a.created_by::text as owner from allocation a join payment_instrument i on i.id = a.instrument_id
                join client c on c.id = i.client_id where c.name = 'al' || $1`,
  },
  sales_order: {
    writers: ['owner', 'office'],
    seed: async (tx, actor) => insertOrder(tx, actor, await orderMaster(app, actors.owner, marker)),
    visible: `select o.created_by::text as owner from sales_order o join client c on c.id = o.client_id
               where c.name = 'fx' || $1`,
  },
  payment_plan_item: {
    // The items are written together with their order by the same actors (seeded by the sales_order fixture above).
    writers: ['owner', 'office'],
    seed: async () => undefined,
    visible: `select i.created_by::text as owner from payment_plan_item i join sales_order o on o.id = i.order_id
                join client c on c.id = o.client_id where c.name = 'fx' || $1`,
  },
  purchase: {
    writers: ['owner', 'office'],
    seed: async (tx, actor) => insertPurchase(tx, actor, await purchaseMaster(app, actors.owner, marker)),
    visible: `select p.created_by::text as owner from purchase p join supplier s on s.id = p.supplier_id
                where s.name = 'ps' || $1`,
  },
  purchase_line: {
    // Written together with their purchase by the same actors (seeded by the purchase fixture above).
    writers: ['owner', 'office'],
    seed: async () => undefined,
    visible: `select l.created_by::text as owner from purchase_line l join purchase p on p.id = l.purchase_id
                join supplier s on s.id = p.supplier_id where s.name = 'ps' || $1`,
  },
  purchase_plan_item: {
    writers: ['owner', 'office'],
    seed: async () => undefined,
    visible: `select i.created_by::text as owner from purchase_plan_item i join purchase p on p.id = i.purchase_id
                join supplier s on s.id = p.supplier_id where s.name = 'ps' || $1`,
  },
  purchase_receipt: {
    // Only record_receipt() writes it (owner, partner, plant); every writer receives a purchase of its own.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx) => {
      const pm = await purchaseMaster(app, actors.owner, marker);
      const p = await newReceivablePurchase(app, actors.owner, pm, marker);
      return tx.query(`select public.record_receipt($1, '2026-06-02')`, [p.id]);
    },
    // Through the quantities view: partner and plant read no purchase table.
    visible: `select r.created_by::text as owner from purchase_receipt r join purchase_line_ops o on o.purchase_id = r.purchase_id
                where o.name_fr = 'ps' || $1`,
  },
  stock_threshold: {
    writers: ['owner', 'partner'],
    seed: async (tx, actor) => {
      const pm = await purchaseMaster(app, actors.owner, marker);
      return tx.query(
        `insert into stock_threshold (id, component_id, low_qty_base, created_by) values (gen_random_uuid(), $1, 1000, $2)`,
        [pm.componentId, actor],
      );
    },
    visible: `select t.created_by::text as owner from stock_threshold t join component c on c.id = t.component_id
                where c.name_fr = 'ps' || $1`,
  },
  invoice: {
    writers: ['owner', 'office'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      const delivery = await newDelivery(app, actors.owner, marker, scene, 50, 2098);
      return insertInvoice(tx, actor, scene, delivery, `dl${marker}`);
    },
    visible: `select i.created_by::text as owner from invoice i where i.client_name = 'dl' || $1`,
  },
  invoice_line: {
    // Written together with their invoice by the same actors (seeded by the invoice fixture above).
    writers: ['owner', 'office'],
    seed: async () => undefined,
    visible: `select l.created_by::text as owner from invoice_line l join invoice i on i.id = l.invoice_id
                where i.client_name = 'dl' || $1`,
  },
  doc_sequence: {
    // Written only through next_doc_number(): owner and office may call it. Persistent by design, like code_sequence.
    writers: ['owner', 'office'],
    seed: (tx, actor) => {
      const role = Object.entries(actors).find(([, id]) => id === actor)![0];
      return tx.query(`select public.next_doc_number($1, 2099, 5)`, [
        { owner: 'MXO', office: 'MXF' }[role as 'owner' | 'office'],
      ]);
    },
    get visible() {
      return `select case prefix when 'MXO' then '${actors.owner}' when 'MXF' then '${actors.office}' end as owner
                from doc_sequence where prefix in ('MXO', 'MXF') and year = 2099 and $1::text is not null`;
    },
  },
  client: {
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person')`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(name, ':', 2) as owner from client where name like $1 || ':%'`,
  },
  client_site: {
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into client_site (id, client_id, label)
         select gen_random_uuid(), id, $2 from client where name like $1 || ':%' limit 1`,
        [marker, `site:${marker}:${actor}`],
      ),
    visible: `select split_part(label, ':', 3) as owner from client_site where label like 'site:' || $1 || ':%'`,
  },
  component: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g')`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(name_fr, ':', 2) as owner from component where name_fr like $1 || ':%'`,
  },
  purchase_unit: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into purchase_unit (id, component_id, label, factor_to_base)
         values (gen_random_uuid(), (select id from component order by code limit 1), $1, 1)`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(label, ':', 2) as owner from purchase_unit where label like $1 || ':%'`,
  },
  concrete_type: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'X' || upper(substr(md5(random()::text), 1, 8)), $1)`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(label, ':', 2) as owner from concrete_type where label like $1 || ':%'`,
  },
  recette: {
    writers: ['owner', 'partner'],
    seed: async (tx, actor) => {
      const type = await tx.query<{ id: string }>(
        `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'R' || upper(substr(md5(random()::text), 1, 8)), $1) returning id`,
        [`r${marker}:${actor}`],
      );
      await tx.query(
        `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 1, '2000-01-01', $2)`,
        [type.rows[0]?.id, actor],
      );
    },
    visible: `select split_part(t.label, ':', 2) as owner from recette r join concrete_type t on t.id = r.concrete_type_id where t.label like 'r' || $1 || ':%'`,
  },
  recette_line: {
    writers: ['owner', 'partner'],
    seed: async (tx, actor) => {
      const type = await tx.query<{ id: string }>(
        `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'L' || upper(substr(md5(random()::text), 1, 8)), $1) returning id`,
        [`l${marker}:${actor}`],
      );
      const recette = await tx.query<{ id: string }>(
        `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 1, '2000-01-01', $2) returning id`,
        [type.rows[0]?.id, actor],
      );
      await tx.query(
        `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, (select id from component order by code limit 1), 1)`,
        [recette.rows[0]?.id],
      );
    },
    visible: `select split_part(t.label, ':', 2) as owner from recette_line l join recette r on r.id = l.recette_id join concrete_type t on t.id = r.concrete_type_id where t.label like 'l' || $1 || ':%'`,
  },
  purchase_price: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const supplier = await tx.query<{ id: string }>(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other') returning id`,
        [`pp${marker}:${actor}`],
      );
      const component = await tx.query<{ id: string }>(
        `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g') returning id`,
        [`pp${marker}:${actor}`],
      );
      const unit = await tx.query<{ id: string }>(
        `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 'kg', 1000) returning id`,
        [component.rows[0]?.id],
      );
      await tx.query(
        `insert into purchase_price (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by)
         values (gen_random_uuid(), $1, $2, $3, 100, '2000-01-01', $4)`,
        [component.rows[0]?.id, supplier.rows[0]?.id, unit.rows[0]?.id, actor],
      );
    },
    visible: `select split_part(s.name, ':', 2) as owner from purchase_price p join supplier s on s.id = p.supplier_id where s.name like 'pp' || $1 || ':%'`,
  },
  selling_price: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const type = await tx.query<{ id: string }>(
        `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'S' || upper(substr(md5(random()::text), 1, 8)), $1) returning id`,
        [`s${marker}:${actor}`],
      );
      await tx.query(
        `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
         values (gen_random_uuid(), $1, null, 100, '2000-01-01', $2)`,
        [type.rows[0]?.id, actor],
      );
    },
    visible: `select split_part(t.label, ':', 2) as owner from selling_price p join concrete_type t on t.id = p.concrete_type_id where t.label like 's' || $1 || ':%'`,
  },
  truck: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into truck (id, code, plate)
         values (gen_random_uuid(), 'T' || (100 + floor(random() * 899))::int, 'M' || substr(md5($1), 1, 6) || substr(replace($2::text, '-', ''), 21, 12))`,
        [marker, actor],
      ),
    // The plate is 19 characters at most: a marker hash and the last 12 hex digits of the actor id.
    visible: `select a as owner from truck t join unnest($2::text[]) a
               on substr(t.plate, 8) = substr(replace(a, '-', ''), 21, 12)
              where left(t.plate, 7) = 'M' || substr(md5($1), 1, 6)`,
    withActors: true,
  },
  truck_status_log: {
    // Plant, owner and partner write the log; the trucks it points at were seeded by the truck fixture just above.
    writers: ['owner', 'partner', 'plant'],
    seed: (tx, actor) =>
      tx.query(
        `insert into truck_status_log (id, truck_id, status, from_date, reason, logged_by)
         values (gen_random_uuid(), (select id from truck where left(plate, 7) = 'M' || substr(md5($1), 1, 6) limit 1), 'breakdown', '2000-01-01', $1, $2)`,
        [marker, actor],
      ),
    visible: `select logged_by::text as owner from truck_status_log where reason = $1`,
  },
  supplier: {
    writers: ['owner', 'partner', 'office'],
    seed: (tx, actor) =>
      tx.query(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other')`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(name, ':', 2) as owner from supplier where name like $1 || ':%'`,
  },
  security_alert_ack: {
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into security_alert_ack (alert_id, user_id, at)
         select id, $2, now() from security_alert where detail like $1 || ':%'`,
        [marker, actor],
      ),
    visible: `select k.user_id::text as owner from security_alert_ack k join security_alert a on a.id = k.alert_id
               where a.detail like $1 || ':%'`,
  },
};

beforeAll(async () => {
  for (const role of USER_ROLES) actors[role] = (await realActor(env.DATABASE_URL_MIGRATOR, role)).id;
  actors.system = SYSTEM_ACTOR_ID;
  actors.anonymous = ANONYMOUS_ACTOR_ID;
  for (const table of RLS_TABLES) {
    for (const role of FIXTURES[table].writers) {
      const pool = FIXTURES[table].pool === 'system' ? system : app;
      await withRlsContext(pool, { userId: actors[role], role, requestId: marker }, (tx) =>
        FIXTURES[table].seed(tx, actors[role]),
      );
    }
  }
});

const visibleArgs = (table: RlsTable) =>
  FIXTURES[table].withActors ? [marker, Object.values(actors)] : [marker];

describe.each(RLS_TABLES)('RLS on %s', (table) => {
  const rule = TABLE_ACCESS[table];

  it.each(DB_ROLES)('role %s sees exactly what the matrix allows', async (role) => {
    const { rows } = await withRlsContext(app, { userId: actors[role], role, requestId: marker }, (tx) =>
      tx.query<{ owner: string }>(FIXTURES[table].visible, visibleArgs(table)),
    );
    const seededBy = FIXTURES[table].writers.map((r) => actors[r]);
    const scope = rule.read[role];
    const expected =
      scope === 'all' ? seededBy : scope === 'own' ? seededBy.filter((a) => a === actors[role]) : [];
    expect(rows.map((r) => r.owner).sort()).toEqual([...expected].sort());
  });

  it('nothing is visible outside a request context', async () => {
    const { rows } = await app.query(FIXTURES[table].visible, visibleArgs(table));
    expect(rows).toEqual([]);
  });
});
