import { createHash, randomUUID } from 'node:crypto';
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
  insertQuote,
  moneyMaster,
  newAdvanceInvoice,
  newAvoir,
  newSupplierInvoice,
  newReceivablePurchase,
  newCashMovement,
  orderMaster,
  purchaseMaster,
} from '../helpers/ledger-fixtures';
import { resetSimClock } from '../helpers/reset-sim-clock';
import { ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID } from '../../src/modules/platform-security/auth/actors';
import { POLICY_ROLES } from '../../src/modules/platform-security/domain/permissions';
import { freeDriverCode, freeTruckCode } from '../helpers/codes';

// AC-SEC-04, generated from the registry: for every RLS table × every role, read exactly what the matrix allows.
type DbRole = (typeof DB_ROLES)[number];
type RlsTable = (typeof RLS_TABLES)[number];

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
let pumpedOrder = '00000000-0000-0000-0000-000000000000';
const migratorPool = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
/** Orders made before any fixture runs (a fixture must not open a second transaction that waits for the first one's counters). */
const preOrders = {} as { status: string; hold: string };
const preField = {} as { trip: string; job: string; driver: string };
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(async () => {
  await resetSimClock();
  await Promise.all([app.end(), system.end(), migratorPool.end()]);
});

const marker = `matrix_${randomUUID().replace(/-/g, '')}`;
// One actor per role: real accounts for user roles, the fixed actors otherwise (the database checks roles, DECISIONS 76).
const actors = {} as Record<DbRole, string>;

/** A loading time computed from the marker, in SQL (`$1`) and in JS, so a fixture can mark the loads it makes. */
const markedSql = (expression: string) =>
  `(timestamptz '2001-01-01 00:00:00+00' + (('x' || substr(md5(${expression}), 1, 6))::bit(24)::int) * interval '1 second')`;
const MARKED_SQL = markedSql('$1');
const MARKED_C_SQL = markedSql("$1 || 'c'");
const markedAt = (m: string): string =>
  new Date(
    Date.UTC(2001, 0, 1) + parseInt(createHash('md5').update(m).digest('hex').slice(0, 6), 16) * 1000,
  ).toISOString();

/** Two plants of their own for a transfer fixture, made in the writer's own transaction; `archivePlants` puts them away again. */
async function transferPlants(tx: pg.PoolClient, owner: string) {
  const letters = (n: number) =>
    Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const ids: string[] = [];
  for (let i = 0; i < 2; i++)
    ids.push(
      (
        await tx.query<{ id: string }>(
          `insert into plant (id, code, name, created_by) values (gen_random_uuid(), $1, $2, $3) returning id`,
          [letters(6), `tp ${marker.slice(-8)} ${i} ${letters(5)}`, owner],
        )
      ).rows[0]!.id,
    );
  return ids as [string, string];
}
const archivePlants = (tx: pg.PoolClient, ids: string[]) =>
  tx.query(`update plant set status = 'archived' where id = any($1::uuid[])`, [ids]);

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
  training_marker: {
    // Written by the maintenance login only (seed:training); no runtime role can write or read it.
    writers: [],
    seed: async () => undefined as never,
    visible: `select 'x' as owner from training_marker where $1::text is not null`,
  },
  plant: {
    // Archived on purpose: an active plant would change the plant rule for every other test sharing this database.
    writers: ['owner', 'partner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into plant (id, code, name, status, created_by)
         values (gen_random_uuid(), upper(translate(substr(md5($1 || $2::text), 1, 8), '0123456789', 'ghijklmnop')), $1 || ':' || $2::text, 'archived', $2::uuid)`,
        [marker, actor],
      ),
    visible: `select split_part(name, ':', 2) as owner from plant where name like $1 || ':%'`,
  },
  receipt_plant_confirmation: {
    // Only confirm_receipt_at_plant() writes it (owner, partner, plant); every writer confirms a purchase of its own.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const pm = await purchaseMaster(app, actors.owner, marker);
      const p = await newReceivablePurchase(
        app,
        actors.owner,
        pm,
        `${marker}c${actor.replace(/-/g, '').slice(-8)}`,
      );
      return tx.query(`select public.confirm_receipt_at_plant($1, $2)`, [p.id, `${marker}:${actor}`]);
    },
    visible: `select split_part(note, ':', 2) as owner from receipt_plant_confirmation where note like $1 || ':%'`,
  },
  receipt_arrival_line: {
    // Only confirm_receipt_at_plant_lines() writes it (owner, partner, plant); every writer counts a purchase of its own.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const pm = await purchaseMaster(app, actors.owner, marker);
      const p = await newReceivablePurchase(
        app,
        actors.owner,
        pm,
        `${marker}l${actor.replace(/-/g, '').slice(-8)}`,
      );
      const line = (
        await migratorPool.query<{ id: string }>(`select id from purchase_line where purchase_id = $1`, [
          p.id,
        ])
      ).rows[0]!.id;
      return tx.query(`select public.confirm_receipt_at_plant_lines($1, $2, $3::jsonb)`, [
        p.id,
        `${marker}L:${actor}`,
        JSON.stringify([{ line, arrived: 1000, rejected: 0, available: false }]),
      ]);
    },
    visible: `select split_part(c.note, ':', 2) as owner from receipt_arrival_line a
                join receipt_plant_confirmation c on c.id = a.confirmation_id where c.note like $1 || 'L:%'`,
  },
  receipt_variance: {
    // Only record_receipt_lines() writes it, when the office documents an arrival the plant counted (owner, partner).
    writers: ['owner', 'partner'],
    seed: async (tx, actor) => {
      const pm = await purchaseMaster(app, actors.owner, `${marker}v`); // its own components: purchase_receipt's visible query reads marker's
      const p = await newReceivablePurchase(
        app,
        actors.owner,
        pm,
        `${marker}v${actor.replace(/-/g, '').slice(-8)}`,
      );
      const line = (
        await migratorPool.query<{ id: string }>(`select id from purchase_line where purchase_id = $1`, [
          p.id,
        ])
      ).rows[0]!.id;
      // The comparison exists only while a plant is active: one plant, made and archived inside this transaction.
      const plantId = (
        await tx.query<{ id: string }>(
          `insert into plant (id, code, name, created_by)
           values (gen_random_uuid(), upper(translate(substr(md5($1 || 'v' || $2::text), 1, 8), '0123456789', 'ghijklmnop')), 'rv ' || substr($1, 8, 10) || right($2::text, 6), $2::uuid) returning id`,
          [marker, actor],
        )
      ).rows[0]!.id;
      await tx.query(`select public.confirm_receipt_at_plant_lines($1, $2, $3::jsonb)`, [
        p.id,
        `${marker}V:${actor}`,
        JSON.stringify([{ line, arrived: 1000, rejected: 0, available: false }]),
      ]);
      await tx.query(`select public.record_receipt_lines($1, current_date, null, false)`, [p.id]);
      return archivePlants(tx, [plantId]);
    },
    visible: `select split_part(c.note, ':', 2) as owner from receipt_variance v
                join receipt_plant_confirmation c on c.id = v.confirmation_id where c.note like $1 || 'V:%'`,
  },
  receipt_arrival_file: {
    // Inserted by the plant, owner and partner on an arrival of their own, before it is documented.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const pm = await purchaseMaster(app, actors.owner, marker);
      const p = await newReceivablePurchase(
        app,
        actors.owner,
        pm,
        `${marker}f${actor.replace(/-/g, '').slice(-8)}`,
      );
      const c = await tx.query<{ id: string }>(`select public.confirm_receipt_at_plant($1, null) as id`, [
        p.id,
      ]);
      return tx.query(
        `insert into receipt_arrival_file (id, confirmation_id, kind, content_type, size_bytes, sha256, uploaded_by)
         values (gen_random_uuid(), $1, 'weighbridge_ticket', 'image/png', 4242, repeat('b', 64), $2)`,
        [c.rows[0]!.id, actor],
      );
    },
    visible: `select uploaded_by::text as owner from receipt_arrival_file where size_bytes = 4242 and $1::text is not null`,
  },
  client_credit_limit: {
    // Written by set_client_credit_limit only (owner); a distinctive limit marks the row.
    writers: ['owner'],
    seed: async (tx) => {
      const c = await tx.query<{ id: string }>(
        `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
        [`ccl${marker}`],
      );
      return tx.query(`select public.set_client_credit_limit($1, 7771)`, [c.rows[0]?.id]);
    },
    visible: `select set_by::text as owner from client_credit_limit where limit_centimes = 7771 and $1::text is not null`,
  },
  order_price_status: {
    // Written by create_order (office_sales) and confirm_order_price; the fixture writes the row as the definer would, on an order of its own.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into order_price_status (order_id, provisional_unit_price_centimes, created_by) values ($1, 1234, $2)`,
          [preOrders.status, actor],
        ),
      ),
    visible: `select created_by::text as owner from order_price_status where provisional_unit_price_centimes = 1234 and $1::text is not null`,
  },
  order_hold: {
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into order_hold (order_id, reason, created_by, note) values ($1, 'credit_limit', $2, $3)`,
          [preOrders.hold, actor, marker],
        ),
      ),
    visible: `select created_by::text as owner from order_hold where note = $1`,
  },
  trip_delay: {
    // Written by driver_report (the driver of the rotation); the fixture writes the row as the definer would. The row is marked by its planned instant.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_delay (id, trip_id, driver_id, trip_date, step, planned_at, tapped_at, cumulative_delay_min, created_by)
           values (gen_random_uuid(), $1, $2, current_date, 'back', $3, now(), 5, $4)`,
          [preField.trip, preField.driver, markedAt(marker), actor],
        ),
      ),
    visible: `select created_by::text as owner from trip_delay where planned_at = ${MARKED_SQL}`,
  },
  trip_estimate_override: {
    // Written by set_trip_estimate; the fixture writes the row as the definer would, for any plant.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_estimate_override (id, plant_id, stage, minutes, reason, created_by)
           values (gen_random_uuid(), (select id from plant order by created_at limit 1), 'to_site', 40, $1, $2)`,
          [`${marker}:${actor}`, actor],
        ),
      ),
    visible: `select split_part(reason, ':', 2) as owner from trip_estimate_override where reason like $1 || ':%'`,
  },
  trip_dispatch_change: {
    // Written by log_dispatch_change; the fixture writes the row as the definer would, on a rotation of its own.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_dispatch_change (id, kind, old_trip_id, reason, created_by) values (gen_random_uuid(), 'postpone', $1, $2, $3)`,
          [preField.trip, `${marker}:${actor}`, actor],
        ),
      ),
    visible: `select split_part(reason, ':', 2) as owner from trip_dispatch_change where reason like $1 || ':%'`,
  },
  trip_overlap_override: {
    // Written by record_dispatch_overlap; the fixture writes the row as the definer would.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_overlap_override (id, batch_id, trip_date, kinds, reason, created_by) values (gen_random_uuid(), gen_random_uuid(), current_date, ARRAY['driver'], $1, $2)`,
          [`${marker}:${actor}`, actor],
        ),
      ),
    visible: `select split_part(reason, ':', 2) as owner from trip_overlap_override where reason like $1 || ':%'`,
  },
  trip_driver_report: {
    // Written by driver_report (the driver of the rotation); the fixture writes the row as the definer would, on a rotation of its own.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_driver_report (id, trip_id, driver_id, kind, at, client_key) values (gen_random_uuid(), $1, $2, 'loading_started', now(), $3)`,
          [preField.trip, preField.driver, `${marker}:${actor}`],
        ),
      ),
    visible: `select split_part(client_key, ':', 2) as owner from trip_driver_report where client_key like $1 || ':%'`,
  },
  driver_bl_photo: {
    // Written by driver_attach_bl_photo (the driver of the rotation); the fixture writes the row as the definer would.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into driver_bl_photo (id, trip_id, driver_id, trip_date, order_code, seq, content_type, size_bytes, sha256, taken_at, client_key)
           values (gen_random_uuid(), $1, $2, current_date, 'CMD-X', 1, 'image/jpeg', 10, repeat('a', 64), now(), $3)`,
          [preField.trip, preField.driver, `${marker}:${actor}`],
        ),
      ),
    visible: `select split_part(client_key, ':', 2) as owner from driver_bl_photo where client_key like $1 || ':%'`,
  },
  trip_emergency: {
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_emergency (id, trip_id, driver_id, step, option, at, client_key) values (gen_random_uuid(), $1, $2, 'start', 'breakdown', now(), $3)`,
          [preField.trip, preField.driver, `${marker}:${actor}`],
        ),
      ),
    visible: `select split_part(client_key, ':', 2) as owner from trip_emergency where client_key like $1 || ':%'`,
  },
  trip_instruction: {
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, async (m) => {
        const e = await m.query<{ id: string }>(
          `select id from trip_emergency where client_key like $1 || ':%' limit 1`,
          [marker],
        );
        return m.query(
          `insert into trip_instruction (id, emergency_id, trip_id, kind, note, created_by) values (gen_random_uuid(), $1, $2, 'continue', $3, $4)`,
          [e.rows[0]?.id, preField.trip, marker, actor],
        );
      }),
    visible: `select created_by::text as owner from trip_instruction where note = $1`,
  },
  pump_job: {
    // Written by create_pump_job; every writer plans a job of its own on a pump and an operator made in the same transaction.
    writers: ['owner', 'partner'],
    seed: async (tx, actor) => {
      const n = Math.floor(Math.random() * 1e9);
      const pump = await tx.query<{ id: string }>(
        `insert into truck (id, code, plate, kind) values (gen_random_uuid(), $2, 'PJ-' || $1::text, 'pump') returning id`,
        [n, await freeTruckCode('P')],
      );
      const op = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id`,
        [await freeDriverCode(), `pj${marker}`, actor],
      );
      return tx.query(`select public.create_pump_job(current_date, $1, $2, null, $3, null, 10)`, [
        pump.rows[0]?.id,
        op.rows[0]?.id,
        `${marker}:${actor}`,
      ]);
    },
    visible: `select split_part(site_label, ':', 2) as owner from pump_job where site_label like $1 || ':%'`,
  },
  order_pump: {
    // Written by set_order_pumped / schedule_pump_job; the fixture writes the row as the definer would, on the order of a rotation
    // made for the field fixtures. The row is found by that order, since other files also mark orders as pumped.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, async (m) => {
        const o = await m.query<{ order_id: string }>(`select order_id from trip_plan where id = $1`, [
          preField.trip,
        ]);
        pumpedOrder = o.rows[0]!.order_id;
        return m.query(`insert into order_pump (order_id, pumped, updated_by) values ($1, true, $2)`, [
          pumpedOrder,
          actor,
        ]);
      }),
    get visible() {
      return `select updated_by::text as owner from order_pump where order_id = '${pumpedOrder}' and $1::text is not null`;
    },
  },
  fuel_tank_opening: {
    // Written by set_fuel_tank_opening; the fixture writes the row as the definer would, on a plant that has no opening yet.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, async (m) => {
        const p = await m.query<{ id: string }>(
          `select id from plant p where not exists (select 1 from fuel_tank_opening o where o.plant_id = p.id) limit 1`,
        );
        return m.query(
          `insert into fuel_tank_opening (plant_id, level_ml, as_of, set_by) values ($1, 1234, current_date, $2)`,
          [p.rows[0]!.id, actor],
        );
      }),
    visible: `select set_by::text as owner from fuel_tank_opening where level_ml = 1234 and $1::text is not null`,
  },
  pump_conflict: {
    // Written by the pump doors and triggers; the fixture writes a double-booking row on a pump job of its own.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, async (m) => {
        const job = await m.query<{ id: string }>(`select id from pump_job limit 1`);
        return m.query(
          `insert into pump_conflict (id, kind, job_date, job_id, detail) values (gen_random_uuid(), 'pump_double_booked', current_date, $1, $2)`,
          [job.rows[0]!.id, `${marker}:${actor}`],
        );
      }),
    visible: `select split_part(detail, ':', 2) as owner from pump_conflict where detail like $1 || ':%'`,
  },
  pump_job_event: {
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into pump_job_event (id, job_id, step, at, client_key, created_by) values (gen_random_uuid(), $1, 'arrived', now(), $2, $3)`,
          [preField.job, `${marker}-pe`, actor],
        ),
      ),
    visible: `select created_by::text as owner from pump_job_event where client_key = $1 || '-pe'`,
  },
  disclosure_request: {
    // Written by request_disclosure (the offices and the plant); the figure itself is never stored.
    writers: ['office', 'plant'],
    seed: async (tx) => {
      const code = (
        await migratorPool.query<{ code: string }>('select code from sales_order where id = $1', [
          preOrders.status,
        ])
      ).rows[0]?.code;
      return tx.query(`select public.request_disclosure('order_total', $1, 'order', $1, $2)`, [code, marker]);
    },
    visible: `select requester::text as owner from disclosure_request where reason = $1`,
  },
  cancellation_policy: {
    writers: ['owner'],
    // a door that needs the step-up mark (D3): the fixture stands for a stepped-up request
    seed: async (tx) => {
      await tx.query(`select set_config('app.step_up', 'verified', true)`);
      return tx.query(`select public.set_cancellation_policy(false, false)`);
    },
    visible: `select updated_by::text as owner from cancellation_policy where updated_by is not null and $1::text is not null`,
  },
  cancellation_case: {
    // One case per writer on the preset rotation's order (the database allows one per order and case number).
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into cancellation_case (order_id, case_no, reason, opened_by, status, decision, decided_by, decided_role, decided_at)
           select order_id, 1 + (select count(*)::int from cancellation_case c where c.order_id = t.order_id and c.trip_id is null), $2, $1, 'decided', 'none', $1, 'owner', now()
             from trip_plan t where t.id = $3`,
          [actor, `${marker}:${actor}`, preField.trip],
        ),
      ),
    visible: `select split_part(reason, ':', 2) as owner from cancellation_case where reason like $1 || ':%'`,
  },
  document_policy: {
    writers: ['owner'],
    seed: (tx) => tx.query(`select public.set_invoice_timing('monthly')`),
    visible: `select updated_by::text as owner from document_policy where updated_by is not null and $1::text is not null`,
  },
  document_request: {
    // An office asks for a document of a client made by the owner in the same test.
    writers: ['office'],
    seed: async (tx, actor) => {
      const code = await withRlsContext(
        app,
        { userId: actors.owner, role: 'owner', requestId: marker },
        async (m) =>
          (
            await m.query<{ code: string }>(
              `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning code`,
              [`dr${actor.slice(0, 8)}${marker.slice(-6)}`],
            )
          ).rows[0]!.code,
      );
      return tx.query(`select public.request_document('releve', 'client', $1, null, $2)`, [code, marker]);
    },
    visible: `select requester::text as owner from document_request where note = $1`,
  },
  survey: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `select public.create_survey('driver', $1, '[{"id":"q1","text":"Question","kind":"yes_no"}]'::jsonb)`,
        [`${marker}:${actor}`],
      ),
    visible: `select split_part(title, ':', 2) as owner from survey where title like $1 || ':%'`,
  },
  survey_response: {
    // The owner makes a survey for the office; each office account answers it once.
    writers: ['office'],
    seed: async (tx) => {
      const id = await withRlsContext(
        app,
        { userId: actors.owner, role: 'owner', requestId: marker },
        async (m) =>
          (
            await m.query<{ id: string }>(
              `select public.create_survey('office', $1, '[{"id":"q1","text":"Question","kind":"yes_no"}]'::jsonb) as id`,
              [`${marker}-resp-${Math.random().toString(36).slice(2, 8)}`],
            )
          ).rows[0]!.id,
      );
      return tx.query(`select public.answer_survey($1, '{"q1": true}'::jsonb)`, [id]);
    },
    visible: `select r.respondent::text as owner from survey_response r join survey s on s.id = r.survey_id where s.title like $1 || '-resp-%'`,
  },
  plant_transfer: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const [a, b] = await transferPlants(tx, actor);
      await tx.query(`select public.transfer_send('fuel', $1, $2, null, 100, '2096-04-05', $3)`, [
        a,
        b,
        marker,
      ]);
      await archivePlants(tx, [a, b]);
    },
    visible: `select s.actor::text as owner from plant_transfer t join plant_transfer_step s on s.transfer_id = t.id and s.step = 'sent' where s.note = $1`,
  },
  plant_transfer_step: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const [a, b] = await transferPlants(tx, actor);
      await tx.query(`select public.transfer_send('fuel', $1, $2, null, 100, '2096-04-05', $3)`, [
        a,
        b,
        `${marker}-s`,
      ]);
      await archivePlants(tx, [a, b]);
    },
    visible: `select actor::text as owner from plant_transfer_step where note = $1 || '-s'`,
  },
  day_close: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const [a, b] = await transferPlants(tx, actor);
      await tx.query(`select public.close_day($1, '2096-04-05', false, null)`, [a]);
      await archivePlants(tx, [a, b]);
    },
    visible: `select closed_by::text as owner from day_close where close_date = '2096-04-05' and $1::text is not null`,
  },
  notification: {
    // Every role sends itself a test notification; each reads only its own.
    writers: ['owner', 'partner', 'office', 'plant', 'support'],
    seed: (tx) => tx.query(`select public.send_test_notification()`),
    visible: `select distinct recipient::text as owner from notification where kind = 'test' and $1::text is not null`,
  },
  push_subscription: {
    // Written by save_push_subscription; nobody reads the table.
    writers: ['owner', 'partner', 'office', 'plant', 'support'],
    seed: (tx, actor) =>
      tx.query(`select public.save_push_subscription($1 || '/' || $2::text, 'k', 'a')`, [
        `https://web.push.apple.com/${marker}`,
        actor,
      ]),
    visible: `select user_id::text as owner from push_subscription where endpoint like $1 || '%'`,
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
    // Numbered in the year 2077 (no other suite loads in that year, the plant-views suite uses 2099) so that the rows of this fixture are the only ones the query below finds (office cannot join orders).
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) =>
      insertDelivery(tx, actor, await deliveryScene(app, actors.owner, marker), 100, 2077),
    visible: `select created_by::text as owner from delivery where bl_no like 'BL-2077-%' and $1::text is not null`,
  },
  driver: {
    writers: ['owner', 'partner'],
    seed: async (tx, actor) =>
      tx.query(
        `insert into driver (id, code, name, created_by)
         values (gen_random_uuid(), $3, $1::text, $2::uuid)`,
        [marker, actor, await freeDriverCode()],
      ),
    visible: `select created_by::text as owner from driver where name = $1`,
  },
  trip_plan: {
    // A far-away date no other suite plans on; the order is a live one of the delivery scene, the truck the pilot's T1.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      return tx.query(
        `with s as (select coalesce(max(seq), 0) + 1 as n from trip_plan where trip_date = '2097-03-02' and order_id = $1)
         insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by)
         select gen_random_uuid(), gen_random_uuid(), '2097-03-02', $1, s.n, $2, 1000, 420 + 100 * s.n, 430 + 100 * s.n, 455 + 100 * s.n, 485 + 100 * s.n, 520 + 100 * s.n, $3 from s`,
        [scene.orderId, scene.truckId, actor],
      );
    },
    visible: `select created_by::text as owner from trip_plan where trip_date = '2097-03-02' and $1::text is not null`,
  },
  trip_plan_cancellation: {
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      const plan = await tx.query<{ id: string }>(
        `with s as (select coalesce(max(seq), 0) + 1 as n from trip_plan where trip_date = '2096-03-02' and order_id = $1)
         insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by)
         select gen_random_uuid(), gen_random_uuid(), '2096-03-02', $1, s.n, $2, 1000, 420 + 100 * s.n, 430 + 100 * s.n, 455 + 100 * s.n, 485 + 100 * s.n, 520 + 100 * s.n, $3 from s returning id`,
        [scene.orderId, scene.truckId, actor],
      );
      return tx.query(
        `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'replanned', $2)`,
        [plan.rows[0]?.id, actor],
      );
    },
    visible: `select c.created_by::text as owner from trip_plan_cancellation c join trip_plan p on p.id = c.trip_id
                where p.trip_date = '2096-03-02' and $1::text is not null`,
  },
  trip_event: {
    // Each writer plans a rotation of its own, loads it (a delivery of year 2095) and records the first step.
    writers: ['owner'], // T8 (0208): partner no longer inserts or reads steps; T9 (0209): the plant manager records through record_trip_stage, not by direct insert
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      const plan = await tx.query<{ id: string }>(
        `with s as (select coalesce(max(seq), 0) + 1 as n from trip_plan where trip_date = '2095-03-02' and order_id = $1)
         insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by)
         select gen_random_uuid(), gen_random_uuid(), '2095-03-02', $1, s.n, $2, 1000, 420 + 100 * s.n, 430 + 100 * s.n, 455 + 100 * s.n, 485 + 100 * s.n, 520 + 100 * s.n, $3 from s returning id`,
        [scene.orderId, scene.truckId, actor],
      );
      const delivery = await insertDelivery(tx, actor, scene, 100, 2095);
      return tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now(), $2, $3)`,
        [plan.rows[0]?.id, delivery.id, actor],
      );
    },
    visible: `select e.created_by::text as owner from trip_event e join trip_plan p on p.id = e.trip_id
                where p.trip_date = '2095-03-02' and e.step = 'loaded' and e.delivery_id is not null and $1::text is not null`,
  },
  trip_event_correction: {
    // T9: written by correct_trip_stage; the fixture writes the row as the definer would, on the committed first stage of the shared rotation.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_event_correction (id, trip_id, step, corrected_at, previous_at, reason, actor_id, actor_role)
           values (gen_random_uuid(), $1, 'loading_started', now(), now(), $2, $3, 'owner')`,
          [preField.trip, marker, actor],
        ),
      ),
    visible: `select c.actor_id::text as owner from trip_event_correction c where c.reason = $1`,
  },
  trip_event_confirmation: {
    // T9b: written by confirm_trip_stage; the fixture writes the row as the definer would, on a second committed stage of the shared rotation.
    writers: ['owner'],
    seed: (_tx, actor) =>
      withRlsContext(migratorPool, { userId: actor, role: 'owner', requestId: marker }, (m) =>
        m.query(
          `insert into trip_event_confirmation (id, trip_id, step, confirmed_at, actor_id, actor_role)
           values (gen_random_uuid(), $1, 'departed', $2, $3, 'owner')`,
          [preField.trip, markedAt(marker), actor],
        ),
      ),
    visible: `select c.actor_id::text as owner from trip_event_confirmation c where c.confirmed_at = ${MARKED_SQL}`,
  },
  fuel_fill: {
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      return tx.query(
        `insert into fuel_fill (id, truck_id, filled_on, litres_ml, odometer_km, source, created_by)
         values (gen_random_uuid(), $1, '2094-03-02', 180000, null, 'tank', $2)`,
        [scene.truckId, actor],
      );
    },
    visible: `select created_by::text as owner from fuel_fill where filled_on = '2094-03-02' and $1::text is not null`,
  },
  fuel_purchase: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into fuel_purchase (id, purchased_on, litres_ml, total_centimes, created_by)
         values (gen_random_uuid(), '2094-03-02', 1000000, 1234500, $1)`,
        [actor],
      ),
    visible: `select created_by::text as owner from fuel_purchase where purchased_on = '2094-03-02' and $1::text is not null`,
  },
  delivery_delivered: {
    // Each writer delivers a load of its own (year 2092) outside any rotation, by hand, through the definer door mark_load_delivered (R18-07:
    // the application login has no INSERT; the reserved role partner has no accounts and is not a writer).
    writers: ['owner', 'plant'],
    seed: async (tx, actor) => {
      const delivery = await newDelivery(
        app,
        actors.owner,
        marker,
        await deliveryScene(app, actors.owner, marker),
        40,
        2092,
      );
      return tx.query('select public.mark_load_delivered($1, now())', [delivery.id]);
    },
    visible: `select g.created_by::text as owner from delivery_delivered g join delivery d on d.id = g.delivery_id where d.bl_no like 'BL-2092-%' and $1::text is not null`,
  },
  delivery_file: {
    // One scan per load: each writer gets a delivery of its own (year 2091) with its signed return, made by the owner.
    writers: ['owner', 'partner', 'office', 'plant'],
    seed: async (tx, actor) => {
      const delivery = await newDelivery(
        app,
        actors.owner,
        marker,
        await deliveryScene(app, actors.owner, marker),
        40,
        2091,
      );
      await withRlsContext(app, { userId: actors.owner, role: 'owner', requestId: marker }, (o) =>
        o.query(
          `insert into delivery_return (id, delivery_id, returned_on, created_by) values (gen_random_uuid(), $1, '2026-06-02', $2)`,
          [delivery.id, actors.owner],
        ),
      );
      return tx.query(
        `insert into delivery_file (id, delivery_id, content_type, size_bytes, sha256, uploaded_by) values (gen_random_uuid(), $1, 'image/png', 10, repeat('a', 64), $2)`,
        [delivery.id, actor],
      );
    },
    visible: `select f.uploaded_by::text as owner from delivery_file f join delivery d on d.id = f.delivery_id where d.bl_no like 'BL-2091-%' and $1::text is not null`,
  },
  delivery_loss: {
    // One loss per load: each writer gets a delivery of its own (year 2093), made by the owner.
    writers: ['owner', 'partner', 'office', 'plant'],
    seed: async (tx, actor) => {
      const delivery = await newDelivery(
        app,
        actors.owner,
        marker,
        await deliveryScene(app, actors.owner, marker),
        40,
        2093,
      );
      return tx.query(
        `insert into delivery_loss (id, delivery_id, volume_l, reason, created_by) values (gen_random_uuid(), $1, 40, 'quality', $2)`,
        [delivery.id, actor],
      );
    },
    visible: `select l.created_by::text as owner from delivery_loss l join delivery d on d.id = l.delivery_id where d.bl_no like 'BL-2093-%' and $1::text is not null`,
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
    writers: ['owner'],
    seed: async (tx, actor) => insertOrder(tx, actor, await orderMaster(app, actors.owner, marker)),
    visible: `select o.created_by::text as owner from sales_order o join client c on c.id = o.client_id
               where c.name = 'fx' || $1`,
  },
  payment_plan_item: {
    // The items are written together with their order by the same actors (seeded by the sales_order fixture above).
    writers: ['owner'],
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
  delivery_excess: {
    // Written by the AFTER INSERT trigger of delivery: every writer loads an order of its own past its volume (8 m³ twice, 10 ordered).
    // The loads carry a loading time derived from the marker, which is how the rows are found again (the partner and the plant
    // read no order or client).
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, `${marker}x${actor.replace(/-/g, '').slice(-8)}`);
      await insertDelivery(tx, actor, scene, 8_000, 2026, markedAt(marker));
      return insertDelivery(tx, actor, scene, 8_000, 2026, markedAt(marker));
    },
    visible: `select x.created_by::text as owner from delivery_excess x join delivery d on d.id = x.delivery_id
                where d.loaded_at = ${MARKED_SQL}`,
  },
  delivery_excess_confirmation: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, `${marker}y`);
      await insertDelivery(tx, actor, scene, 8_000, 2026, markedAt(`${marker}c`));
      await insertDelivery(tx, actor, scene, 8_000, 2026, markedAt(`${marker}c`));
      return tx.query(
        `insert into delivery_excess_confirmation (id, excess_id, created_by)
         select gen_random_uuid(), x.id, $2 from delivery_excess x join delivery d on d.id = x.delivery_id
          where d.loaded_at = ${MARKED_C_SQL} and d.order_id = $3 limit 1`,
        [marker, actor, scene.orderId],
      );
    },
    visible: `select cf.created_by::text as owner from delivery_excess_confirmation cf join delivery_excess x on x.id = cf.excess_id
                join delivery d on d.id = x.delivery_id where d.loaded_at = ${MARKED_C_SQL}`,
  },
  purchase_receipt_line: {
    // Written with its receipt by record_receipt() (owner, partner, plant); every writer receives a purchase of its own.
    writers: ['owner', 'partner', 'plant'],
    seed: async (tx) => {
      const pm = await purchaseMaster(app, actors.owner, `${marker}l`);
      const p = await newReceivablePurchase(app, actors.owner, pm, `${marker}l`);
      return tx.query(`select public.record_receipt($1, '2026-06-02')`, [p.id]);
    },
    visible: `select r.created_by::text as owner from purchase_receipt_line rl join purchase_receipt r on r.id = rl.receipt_id
                join purchase_line_ops o on o.purchase_id = r.purchase_id where o.name_fr = 'ps' || $1 || 'l'`,
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
    writers: ['owner'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      const delivery = await newDelivery(app, actors.owner, marker, scene, 50, 2098);
      return insertInvoice(tx, actor, scene, delivery, `dl${marker}`);
    },
    visible: `select i.created_by::text as owner from invoice i where i.client_name = 'dl' || $1`,
  },
  invoice_line: {
    // Written together with their invoice by the same actors (seeded by the invoice fixture above).
    writers: ['owner'],
    seed: async () => undefined,
    visible: `select l.created_by::text as owner from invoice_line l join invoice i on i.id = l.invoice_id
                where i.client_name = 'dl' || $1`,
  },
  supplier_invoice: {
    // Written by create_supplier_invoice only: the owner's fixture buys 30 t, receives them and enters the invoice.
    writers: ['owner'],
    seed: async (tx, actor) => {
      await newSupplierInvoice(tx, actor, marker);
    },
    visible: `select s.created_by::text as owner from supplier_invoice s where s.supplier_invoice_no = 'FS-' || $1`,
  },
  supplier_invoice_file: {
    // Written by attach_supplier_invoice_file only: the owner's fixture enters an invoice and attaches a document (its own marker).
    writers: ['owner'],
    seed: async (tx, actor) => {
      await newSupplierInvoice(tx, actor, `${marker}f`, { withFile: true });
    },
    visible: `select f.created_by::text as owner from supplier_invoice_file f join supplier_invoice s on s.id = f.supplier_invoice_id
                where s.supplier_invoice_no = 'FS-' || $1 || 'f'`,
  },
  supplier_invoice_line: {
    // Written together with their invoice (seeded by the fixture above).
    writers: ['owner'],
    seed: async () => undefined,
    visible: `select l.created_by::text as owner from supplier_invoice_line l join supplier_invoice s on s.id = l.supplier_invoice_id
                where s.supplier_invoice_no = 'FS-' || $1`,
  },
  supplier_invoice_receipt: {
    writers: ['owner'],
    seed: async () => undefined,
    visible: `select r.created_by::text as owner from supplier_invoice_receipt r join supplier_invoice s on s.id = r.supplier_invoice_id
                where s.supplier_invoice_no = 'FS-' || $1`,
  },
  supplier_invoice_event: {
    writers: ['owner'],
    seed: async () => undefined,
    visible: `select e.created_by::text as owner from supplier_invoice_event e join supplier_invoice s on s.id = e.supplier_invoice_id
                where s.supplier_invoice_no = 'FS-' || $1`,
  },
  avoir: {
    // Written by issue_avoir only: the owner's fixture invoices a load, records its loss and issues the avoir.
    writers: ['owner'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      const master = await orderMaster(app, actors.owner, marker);
      const made = await newAvoir(tx, actor, master, scene, `${marker}av`);
      if (!made.avoirNumber) throw new Error('the avoir was refused');
    },
    visible: `select a.created_by::text as owner from avoir a join client c on c.id = a.client_id where c.name = 'adv' || $1 || 'av'`,
  },
  invoice_advance: {
    // Written by create_invoice_from_deliveries only: the owner's fixture pays an advance and invoices a delivered load.
    writers: ['owner'],
    seed: async (tx, actor) => {
      const scene = await deliveryScene(app, actors.owner, marker);
      const master = await orderMaster(app, actors.owner, marker);
      const made = await newAdvanceInvoice(tx, actor, master, scene, marker);
      if (!made.number) throw new Error('the advance invoice was refused');
    },
    visible: `select a.created_by::text as owner from invoice_advance a join invoice i on i.id = a.invoice_id
                where i.client_name = 'adv' || $1`,
  },
  alert: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into alert (id, rule_id, subject_key, first_detected_on, created_by)
         values (gen_random_uuid(), 'CASH-DEFICIT', $1, current_date, $2)`,
        [`${marker}:${actor}`, actor],
      ),
    visible: `select split_part(subject_key, ':', 2) as owner from alert where subject_key like $1 || ':%'`,
  },
  alert_event: {
    writers: ['owner'],
    seed: async (tx, actor) => {
      const alert = await tx.query<{ id: string }>(
        `insert into alert (id, rule_id, subject_key, first_detected_on, created_by)
         values (gen_random_uuid(), 'PAY-DUE', $1, current_date, $2) returning id`,
        [`ev${marker}:${actor}`, actor],
      );
      await tx.query(
        `insert into alert_event (id, alert_id, seq, kind, severity, at_date, created_by)
         values (gen_random_uuid(), $1, 1, 'detected', 'urgent', current_date, $2)`,
        [alert.rows[0]?.id, actor],
      );
    },
    visible: `select split_part(a.subject_key, ':', 2) as owner from alert_event e join alert a on a.id = e.alert_id where a.subject_key like 'ev' || $1 || ':%'`,
  },
  cash_decision: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into cash_decision (id, alert_key, option_id, kinds, target_date, coverage_bp, gain_centimes, shortfall_centimes, details, decided_on, created_by)
         values (gen_random_uuid(), $1, 'DEPOSIT-EARLY:x', array['DEPOSIT-EARLY'], current_date, 10000, 100, 100, '{}', current_date, $2)`,
        [`CASH-DEFICIT:${marker}`, actor],
      ),
    visible: `select created_by::text as owner from cash_decision where alert_key = 'CASH-DEFICIT:' || $1`,
  },
  quote: {
    writers: ['owner'],
    seed: async (tx, actor) => insertQuote(tx, actor, await orderMaster(app, actors.owner, marker)),
    visible: `select q.created_by::text as owner from quote q join client c on c.id = q.client_id where c.name = 'fx' || $1`,
  },
  stock_count_tolerance: {
    // Only set_stock_count_tolerance() writes it (owner, app_admin). The row is for one component of its own: a default would change every other suite's tolerance.
    writers: ['owner'],
    seed: async (tx, actor) => {
      const pm = await purchaseMaster(app, actors.owner, marker);
      return tx.query(`select public.set_stock_count_tolerance(null, $1, 150, 0, date '2001-01-02', $2)`, [
        pm.componentId,
        `matrix ${actor}`,
      ]);
    },
    visible: `select t.created_by::text as owner from stock_count_tolerance t join component c on c.id = t.component_id
                where c.name_fr = 'ps' || $1`,
  },
  stock_count: {
    // Only propose_stock_count() writes it, for a plant manager (an account of the actor-role kind, not a policy-role actor): the matrix has no such writer.
    // The doors' own tests (tests/t15-stock-count.int.test.ts) prove who reads which plant's counts.
    writers: [],
    seed: async () => undefined as never,
    visible: `select created_by::text as owner from stock_count where reason = 'matrix ' || $1`,
  },
  stock_count_decision: {
    writers: [],
    seed: async () => undefined as never,
    visible: `select decided_by::text as owner from stock_count_decision where reason = 'matrix ' || $1`,
  },
  reorder_request: {
    // Only create_reorder_request (a plant manager) and the system actor's job write it; no policy-role actor of this matrix can call them.
    // tests/t15-reorder.int.test.ts proves who reads which plant's requests.
    writers: [],
    seed: async () => undefined as never,
    visible: `select created_by::text as owner from reorder_request where reason = 'matrix ' || $1`,
  },
  reorder_request_event: {
    writers: [],
    seed: async () => undefined as never,
    visible: `select created_by::text as owner from reorder_request_event where reason = 'matrix ' || $1`,
  },
  sms_sender: {
    // Only register_sms_sender() writes it (owner, app_admin); the doors' own tests (tests/t15-vehicle-registry.int.test.ts) prove who reads it.
    writers: [],
    seed: async () => undefined as never,
    visible: `select created_by::text as owner from sms_sender where note = 'matrix ' || $1`,
  },
  company_profile: {
    writers: ['owner'],
    seed: (tx, actor) =>
      tx.query(
        `insert into company_profile (id, effective_from, legal_name, legal_form, ice, if_number, rc_number, patente, address, created_by)
         values (gen_random_uuid(), '2000-01-01', $1, 'SARL', '001234567000089', '1', '2', '3', 'Tétouan', $2)`,
        [`cp ${marker}`, actor],
      ),
    visible: `select created_by::text as owner from company_profile where legal_name = 'cp ' || $1`,
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
    seed: async (tx, actor) =>
      tx.query(
        `insert into truck (id, code, plate)
         values (gen_random_uuid(), $3, 'M' || substr(md5($1), 1, 6) || substr(replace($2::text, '-', ''), 21, 12))`,
        [marker, actor, await freeTruckCode('T')],
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
  ai_interaction: {
    // Each role asks one question; every role then reads its own and the system reads all (purge, key rotation).
    writers: ['owner', 'partner', 'office', 'plant', 'support'],
    seed: (tx, actor) =>
      tx.query(
        `insert into ai_interaction (id, user_id, role, locale, provider, model, question_hash, outcome)
         values (gen_random_uuid(), $2, ctx.role(), 'fr', 'fake', 'fake', encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), 'ok')`,
        [marker, actor],
      ),
    visible: `select user_id::text as owner from ai_interaction where question_hash = encode(sha256(convert_to($1::text, 'UTF8')), 'hex')`,
  },
  ai_tool_call: {
    writers: ['owner', 'partner', 'office', 'plant', 'support'],
    seed: async (tx, actor) => {
      const turn = await tx.query<{ id: string }>(
        `insert into ai_interaction (id, user_id, role, locale, provider, model, question_hash, outcome)
         values (gen_random_uuid(), $2, ctx.role(), 'fr', 'fake', 'fake', encode(sha256(convert_to($1::text || 'tc', 'UTF8')), 'hex'), 'ok') returning id`,
        [marker, actor],
      );
      return tx.query(
        `insert into ai_tool_call (id, interaction_id, user_id, seq, tool, args, outcome)
         values (gen_random_uuid(), $1, $2, 1, 'matrix_probe', '{}', 'ok')`,
        [turn.rows[0]?.id, actor],
      );
    },
    visible: `select c.user_id::text as owner from ai_tool_call c where c.tool = 'matrix_probe' and $1::text is not null`,
  },
  ai_proposal: {
    writers: ['owner', 'partner', 'office', 'plant'],
    seed: async (tx, actor) => {
      const turn = await tx.query<{ id: string }>(
        `insert into ai_interaction (id, user_id, role, locale, provider, model, question_hash, outcome)
         values (gen_random_uuid(), $2, ctx.role(), 'fr', 'fake', 'fake', encode(sha256(convert_to($1::text || 'pp', 'UTF8')), 'hex'), 'ok') returning id`,
        [marker, actor],
      );
      return tx.query(
        `insert into ai_proposal (id, interaction_id, user_id, role, action, params_enc, expires_at)
         values (gen_random_uuid(), $1, $2, ctx.role(), 'record_return', $3, now() + interval '1 hour')`,
        [turn.rows[0]?.id, actor, `matrix:${marker}`],
      );
    },
    visible: `select user_id::text as owner from ai_proposal where params_enc = 'matrix:' || $1`,
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
  for (const role of POLICY_ROLES) actors[role] = (await realActor(env.DATABASE_URL_MIGRATOR, role)).id;
  {
    const n = Math.floor(Math.random() * 1e9);
    const scene = await deliveryScene(app, actors.owner, `${marker}fld`);
    await withRlsContext(app, { userId: actors.owner, role: 'owner', requestId: marker }, async (tx) => {
      const drv = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by) values (gen_random_uuid(), $1, $2, $3) returning id`,
        [await freeDriverCode(), `fd${marker}`, actors.owner],
      );
      preField.driver = drv.rows[0]!.id;
      const pump = await tx.query<{ id: string }>(
        `insert into truck (id, code, plate, kind) values (gen_random_uuid(), $2, 'PF-' || $1::text, 'pump') returning id`,
        [n, await freeTruckCode('P')],
      );
      const op = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id`,
        [await freeDriverCode(), `fo${marker}`, actors.owner],
      );
      const job = await tx.query<{ id: string }>(
        `select public.create_pump_job(current_date, $1, $2, null, $3, null, 10) as id`,
        [pump.rows[0]?.id, op.rows[0]?.id, `pre${marker}`],
      );
      preField.job = job.rows[0]!.id;
      const trip = await tx.query<{ id: string }>(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by)
         values (gen_random_uuid(), gen_random_uuid(), '2095-03-02', $1, 1, $2, 1000, 420, 430, 455, 485, 520, $3) returning id`,
        [scene.orderId, scene.truckId, actors.owner],
      );
      preField.trip = trip.rows[0]!.id;
      // T9: a committed first stage on that rotation, for the corrections fixture to refer to
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'loading_started', now(), $2)`,
        [preField.trip, actors.owner],
      );
      for (const step of ['loaded', 'departed']) {
        await tx.query(
          `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, $2, now(), $3)`,
          [preField.trip, step, actors.owner],
        );
      }
    });
  }
  for (const key of ['status', 'hold'] as const) {
    preOrders[key] = (
      await withRlsContext(app, { userId: actors.owner, role: 'owner', requestId: marker }, async (tx) =>
        insertOrder(tx, actors.owner, await orderMaster(app, actors.owner, `${marker}${key}`)),
      )
    ).id;
  }
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
