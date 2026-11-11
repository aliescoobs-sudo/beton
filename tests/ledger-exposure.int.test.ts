import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { OWNER_2FA_RESET_DETAIL } from '../src/modules/platform-security/service/break-glass';
import { testEnv } from './db-env';
import { realActor, type TestActor } from './helpers/actors';
import { insertOrder, orderMaster, type OrderMaster } from './helpers/ledger-fixtures';

// DECISIONS 81: what office, partner and plant can reach (views, functions, error messages, row counts, RETURNING,
// planner statistics) shows no price, total, plan or amount. The seeded order carries amounts that are easy to spot.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const systemPool = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end(), systemPool.end()]));

const marker = `expo_${randomUUID().replace(/-/g, '')}`;
const actors = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', TestActor>;
const inCtx = <T>(role: string, userId: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId, role: role as never, requestId: marker }, fn);
const as = <T>(role: keyof typeof actors, fn: (tx: pg.PoolClient) => Promise<T>) =>
  inCtx(role, actors[role].id, fn);

/** The amounts of the fixture order: unit price, HT, VAT, TTC (centimes) and TTC in dirhams. */
// Not inside a code or a number (CLT-1560, CMD-2026-07800): a counter of the shared test database reaches these values.
const AMOUNTS = /(?<![\w-])(78000|780000|156000|936000|9360|7800|1560)(?![\w-])/;
const leaks = (value: unknown) => AMOUNTS.test(JSON.stringify(value) ?? '');
const errorText = (e: unknown) => {
  const x = e as Record<string, unknown>;
  return JSON.stringify({
    message: x.message,
    detail: x.detail,
    hint: x.hint,
    where: x.where,
    constraint: x.constraint,
    column: x.column,
    table: x.table,
  });
};
async function failure(promise: Promise<unknown>): Promise<{ code?: string; text: string }> {
  try {
    await promise;
  } catch (e) {
    return { code: (e as { code?: string }).code, text: errorText(e) };
  }
  throw new Error('expected the statement to fail');
}

let master: OrderMaster;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    actors[role] = await realActor(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await orderMaster(app, actors.owner.id, marker);
  await as('owner', (tx) => insertOrder(tx, actors.owner.id, master));
});

describe('functions the application role can execute', () => {
  const ALLOWED = [
    'public.close_day(p_plant uuid, p_date date, p_force boolean, p_note text)',
    'public.day_close_status(p_plant uuid, p_date date)',
    'public.day_closes_list(p_from date, p_to date)',
    'public.order_timeline(p_order uuid)',
    'public.training_seeded()',
    'public.transfer_pickup(p_id uuid, p_note text)',
    'public.transfer_receive(p_id uuid, p_qty bigint, p_date date, p_note text)',
    'public.transfer_send(p_kind text, p_from uuid, p_to uuid, p_component uuid, p_qty bigint, p_date date, p_note text)',
    'public.transfers_list()',
    'public.anomaly_report(p_from date, p_to date, p_now timestamp with time zone)',
    'public.answer_survey(p_id uuid, p_answers jsonb)',
    'public.close_survey(p_id uuid)',
    'public.create_survey(p_audience text, p_title text, p_questions jsonb)',
    'public.my_surveys()',
    'public.survey_results(p_id uuid)',
    'public.surveys_list()',
    'public.set_my_locale(p_locale text)',
    'public.decide_document_request(p_id uuid, p_approve boolean)',
    'public.document_requests_pending()',
    'public.invoice_timing()',
    'public.my_document_requests()',
    'public.request_document(p_kind text, p_party_kind text, p_party_code text, p_doc_ref text, p_note text)',
    'public.set_invoice_sequence(p_year integer, p_last integer)',
    'public.set_invoice_timing(p_timing text)',
    'public.use_document_request(p_id uuid)',
    'public.consume_document_copy(p_id uuid, p_kind text, p_doc_ref text)',
    'public.cancel_unproduced_order(p_order uuid, p_reason text, p_today date)',
    'public.cancellation_trip_stage(p_trip uuid)',
    'public.concrete_strength(p_code text)',
    'public.decide_cancellation(p_case uuid, p_decision text, p_redirect_order uuid, p_address_enc text, p_loss_volume_l integer, p_loss_fuel_l integer, p_loss_minutes integer, p_note text, p_charge_client boolean, p_now timestamp with time zone)',
    'public.driver_ack_redirect(p_case uuid)',
    'public.driver_redirects()',
    'public.open_trip_case(p_trip uuid, p_case integer, p_reason text, p_unloaded_l integer, p_sample boolean, p_now timestamp with time zone)',
    'public.redirect_candidates(p_case uuid, p_now timestamp with time zone)',
    'public.set_cancellation_policy(p_plant_may_decide boolean, p_client_charged boolean)',
    'audit.is_money_table(p_table text)',
    'audit.record(p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text)',
    'ctx.ai_proposal_id()',
    'ctx.actor_role()',
    'ctx.driver_id()',
    'ctx.reserved_boundary_on()', // R18-03: a constant the policy functions read (true on every server; the test database switches it off for the reserved-role policy tests)
    'ctx.in_actor_scope(p_global text[], p_plant uuid)', // R18-02: the positive plant-scope predicate (boolean, never NULL); reveals nothing the caller did not pass
    'ctx.manager_tuple_ok(p_plan_plant uuid, p_order_plant uuid, p_truck_plant uuid)', // R19-02: the positive plant-manager tuple predicate (boolean, never NULL); reveals nothing the caller did not pass
    'ctx.require_actor(p_door text, p_roles text[])', // R18-02: the actor-first check of the trip doors; it only raises or returns the caller's own role
    'ctx.require_admitted_actor(p_door text)', // R19-01: refuses a missing, empty, anonymous, system, reserved or inactive actor; returns the role
    'public.create_pump_job(p_date date, p_pump uuid, p_operator uuid, p_client uuid, p_site text, p_address_enc text, p_m3 integer)',
    'public.driver_ack(p_instruction uuid)',
    'public.driver_attach_bl_photo(p_trip uuid, p_file uuid, p_type text, p_size integer, p_sha text, p_at timestamp with time zone, p_key text)', // C3: the driver of the rotation only (checked inside)
    'public.driver_bl_photo_counts(p_date date)', // C3: the driver's own rotations only
    'public.driver_emergency(p_trip uuid, p_option text, p_pct integer, p_note text, p_key text, p_at timestamp with time zone)',
    'public.driver_in_plant_scope(p_driver uuid)', // T10a: a scope predicate for the driver_read / trip_plan policies; true only for the owner roles and a plant manager's own drivers, false without an actor
    'public.driver_instructions()',
    'public.driver_report(p_trip uuid, p_step text, p_at timestamp with time zone, p_key text, p_volume_l integer, p_reason text, p_now timestamp with time zone)', // T5: also records the delay of the tap (own rotation only, checked inside)
    'public.log_dispatch_change(p_kind text, p_old uuid, p_new uuid, p_from_truck uuid, p_to_truck uuid, p_from_driver uuid, p_to_driver uuid, p_reason text)', // T5: owner, app_admin, plant manager of the plant (checked inside)
    'public.set_trip_estimate(p_plant uuid, p_zone uuid, p_stage text, p_minutes integer, p_reason text)', // T5: owner, app_admin, plant manager of the plant (checked inside)
    'public.timing_parameter(p_key text)', // T5: four plan parameters, for the driver, plant manager, owner and app_admin (checked inside)
    'public.record_dispatch_overlap(p_batch uuid, p_date date, p_kinds text[], p_reason text)', // R14-01: the audited override of a double-booking: owner, app_admin, plant manager (checked inside)
    'public.trip_started(p_trip uuid)', // R14-01: whether a rotation has started (an event, or the driver's loading report); read by the dispatch service
    'public.trip_stage_estimate(p_plant uuid, p_zone uuid, p_stage text)', // T5: the estimate of a stage, same roles (checked inside)
    'public.trip_timing(p_date date)', // T5: the timing inputs of the rotations the caller may see (checked inside, scoped)
    'public.mark_load_delivered(p_delivery uuid, p_now timestamp with time zone)', // R18-07: the by-hand door of the billing gate (owner, app_admin, plant manager of the load's plant; checked inside)
    'public.field_session_fence(p_driver uuid, p_device_id uuid, p_gen integer, p_exp bigint)', // R18-05, R19-05: the per-transaction fence (expiry and account lock) of the phone session; raises or returns nothing, reveals nothing
    'public.attach_trip_load(p_trip uuid, p_delivery uuid)', // T9: the plant's load linked once to a declared loaded stage (role and plant checked inside)
    'public.confirm_trip_delivered(p_trip uuid)', // T9: the plant confirms a delivery the driver declared (role and plant checked inside)
    'public.correct_trip_stage(p_trip uuid, p_stage text, p_time timestamp with time zone, p_reason text)', // T9: a correction with a reason (plant manager of the plant, owner, app_admin)
    'public.record_trip_stage(p_trip uuid, p_stage text, p_now timestamp with time zone, p_client_time timestamp with time zone, p_key text, p_delivery uuid, p_reason text)', // T9: the one writer of a stage (role and plant checked inside)
    'public.trip_stages(p_date date)', // T9: the shared status of the rotations the caller may see (scoped inside)
    'public.confirm_trip_stage(p_trip uuid, p_stage text, p_now timestamp with time zone)', // T9b: the plant confirms departed / back (role and plant checked inside)
    'public.trip_delivery_exceptions(p_from date, p_to date)', // T9b: the delivery exception lists (scoped inside, flag only)
    'public.trip_delivery_held_count(p_from date, p_to date)', // T10a addendum: a NUMBER only (no trip, order, client, truck or driver) for the office roles that work the invoice queue
    'public.company_contact_phone()', // T9b: the office number for the driver's tel: link (role checked inside, the phone only)
    'public.set_plant_phone(p_plant uuid, p_phone text)', // T9b addendum: the phone of a plant (owner and app_admin only, checked inside, audited)
    'public.driver_plant_phones(p_date date)', // T9b addendum: the phone of the plant of the driver's own rotations (checked inside)
    'public.driver_trips(p_date date)',
    'public.emergencies_open()',
    'public.emergency_instruct(p_emergency uuid, p_kind text, p_address_enc text, p_map_url text, p_note text, p_join_trip uuid)',
    'public.pump_jobs(p_date date)',
    'public.pump_report(p_job uuid, p_step text, p_at timestamp with time zone, p_key text, p_m3 integer)',
    'ctx.plant_id()',
    'ctx.plant_scope()',
    'ctx.request_id()',
    'ctx.role()',
    'ctx.sim_at()',
    'ctx.sim_now()',
    'ctx.user_id()',
    'public.allocate_to_client(p_instrument uuid, p_client_code text)',
    'public.attach_supplier_invoice_file(p_code text, p_file uuid, p_type text, p_size integer, p_sha text)',
    'public.allocate_to_invoice(p_instrument uuid, p_invoice uuid, p_amount bigint, p_reason text)',
    'public.accept_supplier_invoice_gaps(p_si uuid, p_reason text)',
    'public.allocate_to_order(p_instrument uuid, p_order_code text)',
    'public.allocate_to_purchase(p_instrument uuid, p_purchase_code text)',
    'public.allocate_to_supplier_invoice(p_instrument uuid, p_code text)',
    'public.approve_supplier_invoice(p_si uuid, p_plan jsonb)',
    'public.create_invoice(p_order_code text, p_delivery_ids uuid[], p_due date, p_today date)',
    'public.create_invoice_from_deliveries(p_delivery_ids uuid[], p_due date, p_today date)',
    'public.create_supplier_invoice(p_purchase_code text, p_no text, p_invoice_date date, p_due date, p_lines jsonb, p_receipts uuid[], p_today date)',
    'public.create_order(p_client uuid, p_site uuid, p_zone uuid, p_type uuid, p_volume_l integer, p_delivery date, p_today date, p_brought_by uuid, p_quote uuid, p_plan jsonb, p_vat_default integer)',
    'public.create_quote(p_client uuid, p_type uuid, p_volume_l integer, p_valid_days integer, p_today date, p_vat_default integer)',
    'public.default_cash_account()',
    'public.delivery_note(p_delivery uuid)',
    'public.dispatch_office(p_date date)',
    'public.invoice_payment_state()',
    'public.invoice_queue()',
    'public.issue_avoir(p_delivery uuid, p_reason text, p_today date)',
    'public.ledger_parameter(p_key text)',
    'public.next_code(p_key text, p_width integer)',
    'public.order_chain()',
    'public.ops_parameter(p_key text)',
    'public.next_doc_number(p_prefix text, p_year integer, p_width integer)',
    'public.recette_in_force(p_type uuid, p_plant uuid, p_date date)',
    'public.record_receipt(p_purchase uuid, p_date date)',
    'public.drop_push_subscription(p_endpoint text)',
    'public.mark_notifications_read(p_ids uuid[])',
    'public.my_notifications(p_limit integer)',
    'public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)',
    'public.send_test_notification()',
    'public.unread_notification_count()',
    'public.decide_disclosure(p_id uuid, p_approve boolean, p_mode text, p_minutes integer)',
    'public.disclosures_pending()',
    'public.my_disclosures()',
    'public.request_disclosure(p_kind text, p_ref text, p_document_kind text, p_document_ref text, p_reason text)',
    'public.view_disclosure(p_id uuid)',
    'public.reference_prices(p_today date)',
    'public.invoice_print(p_invoice uuid)',
    'public.invoice_print_index()',
    'public.applied_migrations()', // C2: a count only, for the readiness check; no row, no id
    'public.approvals_pending()',
    'public.client_balance_status(p_today date)',
    'public.confirm_order_price(p_order uuid, p_unit_price bigint)',
    'public.order_approval_state()',
    'public.release_order_hold(p_order uuid, p_note text)',
    'public.set_client_credit_limit(p_client uuid, p_limit bigint)',
    'public.confirm_receipt_at_plant(p_purchase uuid, p_note text)',
    'public.confirm_receipt_at_plant_lines(p_purchase uuid, p_note text, p_lines jsonb)', // C3: the plant (checked inside)
    'public.receipt_states(p_since date)', // C3: quantities and states, no price
    'public.stock_arrived_pending(p_plant uuid)', // C3: quantities per component
    'public.set_order_pumped_by_code(p_code text, p_pumped boolean)',
    'public.set_order_pumped(p_order uuid, p_pumped boolean)', // C3: the offices that plan, the owner roles, the plant (checked inside)
    'public.schedule_pump_job(p_date date, p_pump uuid, p_operator uuid, p_order uuid, p_on_site_min integer, p_setup_min integer, p_duration_min integer, p_site text, p_address_enc text, p_m3 integer)',
    'public.reschedule_pump_job(p_job uuid, p_on_site_min integer)',
    'public.resolve_pump_conflict(p_id uuid)',
    'public._pump_in_scope(p_plant uuid)',
    'public._require_step_up(p_what text)',
    'public.pump_board(p_date date)', // C3: times and codes, no price
    'public.pump_waiting(p_date date)',
    'public.pump_conflicts(p_date date)',
    'public.pump_options()',
    'public.set_fuel_tank_opening(p_plant uuid, p_litres bigint, p_as_of date)',
    'public.fuel_tank_levels()', // C3: litres per plant, no price
    'public.record_receipt_lines(p_purchase uuid, p_date date, p_lines jsonb, p_confirm_excess boolean)',
    'public.reject_supplier_invoice(p_si uuid, p_reason text)',
    'public.resolve_order_price(p_type uuid, p_client uuid, p_date date)', // C3: owner and system only (checked inside)
    'public.resolve_selling_price(p_type uuid, p_client uuid, p_date date)',
    'public.supplier_invoice_match(p_si uuid)',
  ];

  it('is exactly the reviewed list (a new function must be reviewed for exposure and added here)', async () => {
    const { rows } = await migrator.query<{ f: string }>(
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'ctx', 'audit') and p.prokind = 'f'
          and has_function_privilege('belgobeton_app', p.oid, 'EXECUTE')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        order by 1`,
    );
    expect(rows.map((r) => r.f)).toEqual([...ALLOWED].sort());
  });

  it('every SECURITY DEFINER function pins its search_path', async () => {
    const { rows } = await migrator.query<{ f: string }>(
      `select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'ctx', 'audit') and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(rows).toEqual([]);
  });

  it('resolve_selling_price refuses partner, plant, support and anonymous, with a message that holds no amount', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      const f = await failure(
        as(role, (tx) =>
          tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
            master.typeId,
            master.clientId,
            '2026-06-01',
          ]),
        ),
      );
      expect(f.code, role).toBe('42501');
      expect(leaks(f.text), role).toBe(false);
    }
    const anon = await failure(
      inCtx('anonymous', '00000000-0000-7000-8000-000000000000', (tx) =>
        tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
          master.typeId,
          master.clientId,
          '2026-06-01',
        ]),
      ),
    );
    expect(anon.code).toBe('42501');
  });

  it('resolve_selling_price answers the owner only (and the system): office has no door to a price any more', async () => {
    const office = await failure(
      as('office', (tx) =>
        tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
          master.typeId,
          master.clientId,
          '2026-06-01',
        ]),
      ),
    );
    expect(office.code).toBe('42501');
    expect(leaks(office.text)).toBe(false);
    const { rows } = await as('owner', (tx) =>
      tx.query('select * from public.resolve_selling_price($1, $2, $3)', [
        master.typeId,
        master.clientId,
        '2026-06-01',
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  it('ledger_parameter hands the three ledger parameters to office and refuses everyone else and every other key', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      expect(
        (await failure(as(role, (tx) => tx.query(`select public.ledger_parameter('vat_rate_bp')`)))).code,
        role,
      ).toBe('42501');
    }
    expect(
      (
        await failure(
          as('office', (tx) => tx.query(`select public.ledger_parameter('session_idle_minutes')`)),
        )
      ).code,
    ).toBe('42501');
    const { rows } = await as('office', (tx) =>
      tx.query(`select public.ledger_parameter('vat_rate_bp') as v`),
    );
    expect(rows).toHaveLength(1);
  });

  it('next_doc_number numbers documents for owner and office only and returns just a code', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      expect(
        (await failure(as(role, (tx) => tx.query(`select public.next_doc_number('CMD', 2026, 5)`)))).code,
        role,
      ).toBe('42501');
    }
    const { rows } = await as('office', (tx) =>
      tx.query<{ n: string }>(`select public.next_doc_number('CMD', 2026, 5) as n`),
    );
    expect(rows[0]?.n).toMatch(/^CMD-2026-\d{5,}$/);
  });
});

describe('views the application role can read', () => {
  const OPS_COLUMNS = [
    'id',
    'code',
    'concrete_type_id',
    'volume_l',
    'delivery_date',
    'zone_id',
    'site_id',
    'client_code',
    'site_label',
    'reverses_id',
    'is_reversed',
    'plant_id',
  ];

  it("there are exactly three, sales_order_ops, purchase_line_ops and delivered_load; all are security barriers, and delivered_load runs with the caller's rights", async () => {
    const { rows } = await migrator.query<{ v: string; reloptions: string[] | null }>(
      `select n.nspname || '.' || c.relname as v, c.reloptions
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm') and n.nspname in ('public', 'ctx', 'audit')
          and has_table_privilege('belgobeton_app', c.oid, 'SELECT')`,
    );
    expect(rows.map((r) => r.v).sort()).toEqual([
      'public.delivered_load',
      'public.purchase_line_ops',
      'public.sales_order_ops',
    ]);
    for (const r of rows) expect(r.reloptions, r.v).toContain('security_barrier=true');
    expect(rows.find((r) => r.v === 'public.delivered_load')?.reloptions).toContain('security_invoker=true');
  });

  it('exposes operational columns only: no price, total, VAT, plan or amount column', async () => {
    const { rows, fields } = await as('partner', (tx) =>
      tx.query('select * from public.sales_order_ops limit 1'),
    );
    expect(fields.map((f) => f.name).sort()).toEqual([...OPS_COLUMNS].sort());
    for (const name of OPS_COLUMNS)
      expect(name).not.toMatch(/price|total|amount|centimes|vat|ttc|plan(?!t)|\bht\b/i);
    expect(rows).toHaveLength(1);
  });

  it('gives partner, plant and support rows with no amount, and office, system and anonymous no row at all (count included)', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      const { rows } = await as(role, (tx) => tx.query('select * from public.sales_order_ops'));
      expect(rows.length, role).toBeGreaterThan(0);
      expect(leaks(rows), role).toBe(false);
    }
    for (const [role, id] of [
      ['office', actors.office.id],
      ['system', '00000000-0000-7000-8000-000000000001'],
      ['anonymous', '00000000-0000-7000-8000-000000000000'],
    ] as const) {
      const { rows } = await inCtx(role, id, (tx) =>
        tx.query<{ n: string }>('select count(*)::text as n from public.sales_order_ops'),
      );
      expect(rows[0]?.n, role).toBe('0');
    }
    const noContext = await app.query<{ n: string }>(
      'select count(*)::text as n from public.sales_order_ops',
    );
    expect(noContext.rows[0]?.n).toBe('0');
  });

  it('cannot be probed for amounts by filtering or ordering on a column it does not expose', async () => {
    for (const role of ['partner', 'plant'] as const) {
      expect(
        (
          await failure(
            as(role, (tx) =>
              tx.query('select 1 from public.sales_order_ops where total_ttc_centimes = 936000'),
            ),
          )
        ).code,
        role,
      ).toBe('42703');
    }
  });

  it('cannot be written', async () => {
    for (const role of ['owner', 'office', 'partner', 'plant', 'support'] as const) {
      expect(
        (
          await failure(
            as(role, (tx) =>
              tx.query(`update public.sales_order_ops set volume_l = 1 where code is not null`),
            ),
          )
        ).code,
        role,
      ).toMatch(/^(42501|55000)$/); // no privilege, or not an updatable view
    }
  });
});

describe('the money tables themselves, for the roles that must not read them', () => {
  const TABLES = ['sales_order', 'payment_plan_item'] as const;

  it.each(['office', 'partner', 'plant'] as const)(
    '%s: no row, no count, no oracle through a filter, no statistics',
    async (role) => {
      for (const table of TABLES) {
        const all = await as(role, (tx) => tx.query(`select * from ${table}`));
        expect(all.rows, table).toEqual([]);
        const count = await as(role, (tx) =>
          tx.query<{ n: string }>(`select count(*)::text as n from ${table}`),
        );
        expect(count.rows[0]?.n, table).toBe('0');
        const oracle = await as(role, (tx) =>
          tx.query(
            table === 'sales_order'
              ? `select 1 from sales_order where total_ttc_centimes = 936000`
              : `select 1 from payment_plan_item where amount_centimes = 936000`,
          ),
        );
        expect(oracle.rows, table).toEqual([]);
        const sum = await as(role, (tx) =>
          tx.query<{ s: string | null }>(
            table === 'sales_order'
              ? `select sum(total_ttc_centimes)::text as s from sales_order`
              : `select sum(amount_centimes)::text as s from payment_plan_item`,
          ),
        );
        expect(sum.rows[0]?.s, table).toBeNull();
      }
      const stats = await as(role, (tx) =>
        tx.query(
          `select * from pg_stats where schemaname = 'public' and tablename in ('sales_order', 'payment_plan_item', 'selling_price', 'purchase_price', 'correction_request')`,
        ),
      );
      expect(stats.rows).toEqual([]);
      const ext = await as(role, (tx) => tx.query(`select * from pg_stats_ext where schemaname = 'public'`));
      expect(ext.rows).toEqual([]);
    },
  );

  it('office: RETURNING (even through a CTE) is refused and says nothing about the amounts', async () => {
    const insertSql = (
      suffix: string,
    ) => `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date,
        selling_price_id, unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
      values (gen_random_uuid(), 'X-${marker.slice(5, 12)}${suffix}', '${master.clientId}', '${master.typeId}', 10000, '2026-06-01', '2026-06-02',
        '${master.sellingPriceId}', 78000, 2000, 780000, 156000, 936000, '${actors.office.id}')`;
    for (const q of [
      `${insertSql('a')} returning total_ttc_centimes`,
      `${insertSql('b')} returning *`,
      `with ins as (${insertSql('c')} returning *) select * from ins`,
    ]) {
      const f = await failure(as('office', (tx) => tx.query(q)));
      expect(f.code, q).toBe('42501');
      expect(leaks(f.text), q).toBe(false);
    }
  });

  it('office: every direct insert into a document table is refused by RLS with no detail (no guard error to read as an oracle)', async () => {
    const attempts: Record<string, string> = {
      sales_order: `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                                    unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), 'X-1', $1, $2, 10000, '2026-06-01', '2026-06-02', $3, 1, 2000, 10, 2, 12, $4)`,
      quote: `insert into quote (id, code, client_id, concrete_type_id, volume_l, quote_date, valid_until, selling_price_id,
                                    unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), 'DV-X-1', $1, $2, 10000, '2026-06-01', '2026-06-30', $3, 1, 2000, 10, 2, 12, $4)`,
    };
    for (const [table, sql] of Object.entries(attempts)) {
      const f = await failure(
        as('office', (tx) =>
          tx.query(sql, [master.clientId, master.typeId, master.sellingPriceId, actors.office.id]),
        ),
      );
      expect(f.code, table).toBe('42501');
      expect(leaks(f.text), table).toBe(false);
      expect(f.text, table).not.toMatch(/price|78000|in force/);
    }
    const invoice = await failure(
      as('office', (tx) =>
        tx.query(
          `insert into invoice (id, number, order_id, client_id, client_name, invoice_date, issue_deadline, due_date, vat_rate_bp,
                                total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), 'FA-X', gen_random_uuid(), $1, 'x', '2026-06-01', '2026-06-30', '2026-07-30', 2000, 1, 0, 1, $2)`,
          [master.clientId, actors.office.id],
        ),
      ),
    );
    // the invoice guard may answer first (an unknown order id): a plain check violation, which holds no price
    expect(['42501', '23514']).toContain(invoice.code);
    expect(leaks(invoice.text)).toBe(false);
    const duplicate = await migrator.query<{ code: string }>(`select code from sales_order limit 1`);
    expect(duplicate.rows.length).toBeGreaterThan(0);
  });

  it('office: the correction request answers the same for an unknown and an existing code, and shows no amount', async () => {
    const known = await migrator.query<{ code: string }>(`select code from sales_order limit 1`);
    const answers = [];
    for (const code of [known.rows[0]?.code, 'CMD-1999-99999']) {
      answers.push(
        await as('office', (tx) =>
          tx.query(
            `insert into correction_request (id, document_code, reason, requested_by) values (gen_random_uuid(), $1, 'test', $2)`,
            [code, actors.office.id],
          ),
        ).then((r) => ({ ok: true, command: r.command, rowCount: r.rowCount })),
      );
    }
    expect(answers[0]).toEqual(answers[1]);
  });
});

describe('security alerts (break-glass), DECISIONS 75 and 81', () => {
  it('the stored text is a fixed sentence: no amount, balance, client or supplier', () => {
    expect(OWNER_2FA_RESET_DETAIL).not.toMatch(
      /\d{3,}|MAD|DH|centime|solde|balance|montant|amount|client|fournisseur|supplier/i,
    );
  });

  it('the alert kind is closed by the database (a free-form alert cannot be inserted by the application role)', async () => {
    const { rows } = await migrator.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.security_alert'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'`,
    );
    expect(rows[0]?.def).toMatch(/owner_2fa_reset/);
    const f = await failure(
      as('office', (tx) =>
        tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', now(), 'x')`),
      ),
    );
    expect(f.code).toBe('42501');
  });

  it('owner, partner and support can read the alerts; office and plant cannot', async () => {
    await withRlsContext(
      systemPool,
      { userId: '00000000-0000-7000-8000-000000000001', role: 'system', requestId: marker },
      (tx) =>
        tx.query(`insert into security_alert (kind, at, detail) values ('owner_2fa_reset', now(), $1)`, [
          OWNER_2FA_RESET_DETAIL,
        ]),
    );
    for (const role of ['owner', 'partner', 'support'] as const) {
      const { rows } = await as(role, (tx) =>
        tx.query<{ detail: string }>('select detail from security_alert'),
      );
      expect(rows.length, role).toBeGreaterThan(0);
      expect(
        rows.some((r) => r.detail === OWNER_2FA_RESET_DETAIL),
        role,
      ).toBe(true);
    }
    for (const role of ['office', 'plant'] as const) {
      const { rows } = await as(role, (tx) => tx.query('select 1 from security_alert'));
      expect(rows, role).toEqual([]);
    }
  });

  it('every alert row stored so far holds the fixed sentence only', async () => {
    const { rows } = await as('owner', (tx) =>
      tx.query<{ detail: string | null }>("select detail from security_alert where detail like 'Owner 2FA%'"),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.detail).toBe(OWNER_2FA_RESET_DETAIL);
  });
});

describe('review of CP-L4: an office-context call never receives a price, a total, a client or a load', () => {
  const FAKE_CODE = 'CMD-2026-99999';
  const today = '2026-06-10';

  async function ownerOrderWithLoad(): Promise<{ code: string }> {
    const out = await as('owner', async (tx) => {
      const order = await insertOrder(tx, actors.owner.id, master);
      return order;
    });
    return { code: out.code };
  }

  it('create_invoice answers an unknown code, a code with nothing to invoice and a probe alike: NULL, audited', async () => {
    const order = await ownerOrderWithLoad(); // an order with no load: nothing to invoice
    const answers = [];
    for (const code of [FAKE_CODE, order.code]) {
      const { rows } = await as('office', (tx) =>
        tx.query<{ n: string | null }>('select public.create_invoice($1, null, null, $2) as n', [
          code,
          today,
        ]),
      );
      answers.push(rows[0]?.n ?? null);
    }
    expect(answers).toEqual([null, null]);
    const audited = await migrator.query(
      `select reason from audit_event where actor_user_id = $1 and table_name = 'invoice_create' and action = 'permission_denied'`,
      [actors.office.id],
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audited.rows)).not.toMatch(AMOUNTS);
  });

  it('create_invoice locks an actor out after ten failures in ten minutes', async () => {
    const probe = async (n: number) =>
      as('office', (tx) =>
        tx.query('select public.create_invoice($1, null, null, $2) as n', [
          `CMD-2026-9${String(n).padStart(4, '0')}`,
          today,
        ]),
      );
    let refused: { code?: string; text: string } | null = null;
    for (let i = 0; i < 14 && !refused; i++) {
      try {
        await probe(i);
      } catch (error) {
        refused = { code: (error as { code?: string }).code, text: errorText(error) };
      }
    }
    expect(refused?.code).toBe('42501');
    expect(refused?.text).toMatch(/too many failed attempts/);
    expect(leaks(refused?.text)).toBe(false);
  });

  it('create_invoice, create_order and create_quote return a document code and nothing else a person could read a price from', async () => {
    const fresh = await realActor(env.DATABASE_URL_MIGRATOR, 'office');
    const call = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => inCtx('office', fresh.id, fn);
    const order = await call((tx) =>
      tx.query<Record<string, unknown>>(
        `select * from public.create_order($1, null, null, $2, 10000, $3, $4, null, null, $5, 2000)`,
        [master.clientId, master.typeId, '2026-06-12', today, JSON.stringify({ preset: 'cash' })],
      ),
    );
    expect(Object.keys(order.rows[0] ?? {}).sort()).toEqual(['code', 'id']);
    expect(order.fields.map((f) => f.name).sort()).toEqual(['code', 'id']);
    expect(leaks(order.rows)).toBe(false);
    const quote = await call((tx) =>
      tx.query(`select * from public.create_quote($1, $2, 10000, 30, $3, 2000)`, [
        master.clientId,
        master.typeId,
        today,
      ]),
    );
    expect(quote.fields.map((f) => f.name).sort()).toEqual(['code', 'id']);
    expect(leaks(quote.rows)).toBe(false);
  });

  it('a bad plan, an unknown client or type and a missing price give errors that hold no amount', async () => {
    const calls: [string, unknown[]][] = [
      [
        `select * from public.create_order($1, null, null, $2, 10000, $3, $4, null, null, $5, 2000)`,
        [
          master.clientId,
          master.typeId,
          '2026-06-12',
          today,
          JSON.stringify({
            preset: 'custom',
            items: [{ method: 'cash', dueDate: '2026-06-12', amountCentimes: 100 }],
          }),
        ],
      ],
      [
        `select * from public.create_order($1, null, null, $2, 10000, $3, $4, null, null, $5, 2000)`,
        [randomUUID(), master.typeId, '2026-06-12', today, JSON.stringify({ preset: 'cash' })],
      ],
      [
        `select * from public.create_order($1, null, null, $2, 10000, $3, $4, null, null, $5, 2000)`,
        [master.clientId, randomUUID(), '2026-06-12', today, JSON.stringify({ preset: 'cash' })],
      ],
      [
        `select * from public.create_quote($1, $2, 10000, 30, '1999-01-01', 2000)`,
        [master.clientId, master.typeId],
      ],
    ];
    for (const [sql, params] of calls) {
      const f = await failure(as('office', (tx) => tx.query(sql, params)));
      expect(leaks(f.text)).toBe(false);
      expect(f.text).not.toMatch(/78000|780000|936000/);
    }
  });

  it('partner, plant and support cannot call the creators; anonymous neither', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      for (const sql of [
        `select public.create_invoice('${FAKE_CODE}', null, null, '${today}')`,
        `select * from public.create_quote('${master.clientId}', '${master.typeId}', 10, 30, '${today}', 2000)`,
      ]) {
        expect((await failure(as(role, (tx) => tx.query(sql)))).code, `${role} ${sql.slice(0, 30)}`).toBe(
          '42501',
        );
      }
    }
  });
});
