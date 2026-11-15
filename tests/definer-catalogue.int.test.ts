import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';
import { setReservedBoundary } from './setup-db';
import { insertInstrument, newSupplierInvoice } from './helpers/ledger-fixtures';
import {
  ACTOR_FIRST_DOORS,
  AUTH_CREDENTIAL_DOORS,
  CLASS_REASON,
  INTERNAL_PREDICATES,
  PUBLIC_BY_DESIGN,
} from './helpers/definer-classes';

/**
 * R17-04 / R19-01: the class fix, as a CATALOGUE test.
 * (1) The LINT: EVERY SECURITY DEFINER function that the application login OR the auth login can execute (every schema, the history doors and the phone's
 *     credential doors included) either calls the shared helper (ctx.require_admitted_actor / ctx.require_actor) BEFORE its first table access, or is listed
 *     with a class and a written reason in tests/helpers/definer-classes.ts. A new definer that is neither fails the build; a stale entry fails too.
 * (2) The SWEEP: each application-executable door is called with REAL arguments (existing orders, trips, loads, clients, plants, requests... where a table
 *     has a row) and with every request that has no valid actor: no role, an empty role, an unknown role, a wrong-audience role, a role that is not the
 *     user's, a RESERVED role (the production boundary is ON), `anonymous`. The refusal must be EXACT (SQLSTATE 42501), not any exception.
 *     Doors that answer an empty result instead are listed with the reason in ANSWERS_EMPTY. A call that is wrongly accepted is COMMITTED, so the
 *     "wrote nothing" check observes a real write.
 */
const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(async () => {
  await migrator.end();
  await app.end();
});

interface Fn {
  oid: number;
  name: string;
  args: string[];
  argNames: string[];
  retset: boolean;
  rettype: string;
  app: boolean;
  auth: boolean;
  src: string;
}

/** Every definer either login can execute, in every business schema (history and finance included). */
async function catalogue(): Promise<Fn[]> {
  const { rows } = await migrator.query<Fn>(
    `select p.oid::int as oid, n.nspname || '.' || p.proname as name,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality as u(t, i) order by i) as args,
            coalesce(p.proargnames[1:p.pronargs], array[]::text[]) as "argNames",
            p.proretset as retset, format_type(p.prorettype, null) as rettype,
            has_function_privilege('belgobeton_app', p.oid, 'EXECUTE') as app,
            has_function_privilege('belgobeton_auth', p.oid, 'EXECUTE') as auth,
            p.prosrc as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and p.prokind = 'f' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        and (has_function_privilege('belgobeton_app', p.oid, 'EXECUTE') or has_function_privilege('belgobeton_auth', p.oid, 'EXECUTE'))
        and p.prorettype <> 'trigger'::regtype
      order by 2, 1`,
  );
  return rows;
}

const norm = (src: string): string => src.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
/** Position of the first access to a table (a read or a write) in the body; Infinity if none. */
const firstData = (src: string): number => {
  const m = norm(src).search(/\b(FROM|INSERT INTO|UPDATE|DELETE FROM)\b/i);
  return m < 0 ? Infinity : m;
};
const helperAt = (src: string): number => norm(src).search(/ctx\.require_(admitted_)?actor\(/);
const actorAt = (src: string): number =>
  norm(src).search(
    /ctx\.actor_role\(\)|ctx\.role\(\)|ctx\.driver_id\(\)|cancellation_actor_check\(|transfer_actor_ok\(|_require_step_up\(|_pump_actor_check\(|ctx\.in_actor_scope\(|_pump_in_scope\(|ctx\.plant_scope\(\)|confirm_receipt_at_plant\(/,
  );
const helperFirst = (fn: Fn): boolean => helperAt(fn.src) >= 0 && helperAt(fn.src) < firstData(fn.src);

/** Doors that, for a request with no valid actor, answer an empty result instead of raising 42501 (reason beside each). */
const ANSWERS_EMPTY: Record<string, string> = {
  'public.driver_in_plant_scope':
    'a boolean scope predicate over a driver id the caller passed: false for a request with no admitted actor (coalesce), no data returned, no write',
  'public.trip_started':
    'a boolean read of "has this rotation started": false for a request with no admitted actor (its first statement), no data returned, no write',
};

describe('R19-01 (b)(c): every definer the app or auth login can execute is helper-first or reviewed', () => {
  it('lists the catalogue (sanity: the doors are there, history and finance included, and the auth credential doors)', async () => {
    const fns = await catalogue();
    expect(fns.length).toBeGreaterThan(100);
    const names = fns.map((f) => f.name);
    for (const must of [
      'history.volume_report',
      'finance.source_sales',
      'public.field_session_open',
      'public.view_disclosure',
      'ctx.require_admitted_actor',
    ])
      expect(names, must).toContain(must);
  });

  it('every definer calls the helper before its first table access, or is on the reviewed list with a class; the list has no stale or double entry', async () => {
    const fns = await catalogue();
    const byName = new Map(fns.map((f) => [f.name, f]));
    const listed = new Map<string, string[]>();
    const add = (cls: string, names: string[]) =>
      names.forEach((n) => listed.set(n, [...(listed.get(n) ?? []), cls]));
    add('actor-first', ACTOR_FIRST_DOORS);
    add('auth-credential', AUTH_CREDENTIAL_DOORS);
    add('public-by-design', Object.keys(PUBLIC_BY_DESIGN));
    add('internal-predicate', INTERNAL_PREDICATES);
    const unreviewed = fns.filter((f) => !helperFirst(f) && !listed.has(f.name)).map((f) => f.name);
    expect(
      unreviewed,
      'a new definer must call ctx.require_admitted_actor first or be reviewed in definer-classes.ts',
    ).toEqual([]);
    const stale = [...listed.keys()].filter((n) => !byName.has(n));
    expect(stale, 'listed but no longer an executable definer').toEqual([]);
    const redundant = [...listed.entries()]
      .filter(([n]) => byName.get(n) && helperFirst(byName.get(n)!))
      .map(([n]) => n);
    expect(
      redundant.filter((n) => !INTERNAL_PREDICATES.includes(n)),
      'listed although helper-first: remove the entry',
    ).toEqual([]);
    expect([...listed.entries()].filter(([, c]) => c.length > 1).map(([n]) => n)).toEqual([]);
    expect(CLASS_REASON['actor-first'].length).toBeGreaterThan(40);
  });

  it('the actor-first class: the validated actor is read before the first table access (not merely mentioned somewhere)', async () => {
    const fns = new Map((await catalogue()).map((f) => [f.name, f]));
    const offenders = ACTOR_FIRST_DOORS.filter((n) => {
      const f = fns.get(n);
      return !f || !(actorAt(f.src) >= 0 && actorAt(f.src) < firstData(f.src));
    });
    expect(offenders).toEqual([]);
  });

  it('auth credential doors are executable by the auth login ONLY; the auth login holds nothing else of business value', async () => {
    const fns = await catalogue();
    for (const n of AUTH_CREDENTIAL_DOORS) {
      const f = fns.find((x) => x.name === n)!;
      expect(f, n).toBeTruthy();
      expect({ n, app: f.app, auth: f.auth }).toEqual({ n, app: false, auth: true });
    }
    const allowedForAuth = new Set([
      ...AUTH_CREDENTIAL_DOORS,
      ...INTERNAL_PREDICATES,
      ...Object.keys(PUBLIC_BY_DESIGN),
      'ctx.require_admitted_actor',
    ]);
    expect(fns.filter((f) => f.auth && !allowedForAuth.has(f.name)).map((f) => f.name)).toEqual([]);
  });

  it('the self-service doors named by R19-01 are helper-first (not merely listed)', async () => {
    const fns = new Map((await catalogue()).map((f) => [f.name, f]));
    for (const n of [
      'view_disclosure',
      'my_disclosures',
      'consume_document_copy',
      'use_document_request',
      'my_document_requests',
      'my_notifications',
      'mark_notifications_read',
      'unread_notification_count',
      'send_test_notification',
      'set_my_locale',
      'save_push_subscription',
      'drop_push_subscription',
      'my_surveys',
      'answer_survey',
      'transfer_pickup',
      'transfer_receive',
      'decide_cancellation',
    ])
      expect(helperFirst(fns.get(`public.${n}`)!), n).toBe(true);
  });
});

let world: World;
/** R18-02: the REAL rows an argument can point at (a trip, load, order, driver, plant of ANOTHER plant, and a trip with no plant). */
interface Real {
  tripB: string;
  tripN: string;
  loadB: string;
  orderB: string;
  orderN: string;
  orderCodeB: string;
  clientCode: string;
  [table: string]: string;
}
let real: Real;
/** One existing row of a table, found by the migrator; `null` when the table is empty in the test database. */
const anyId = async (table: string): Promise<string | null> =>
  (await migrator.query<{ id: string }>(`select id::text as id from ${table} limit 1`)).rows[0]?.id ?? null;
const reservedUser: { id: string } = { id: '' };
const DAY = '2026-10-07';
beforeAll(async () => {
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, true);
  world = await plantWorld(app, migrator, `dc${randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const b = await world.newTrip(world.plantB, world.truckB, world.driverB);
  const n = await world.newTrip(world.plantA, world.truckN, world.driverA, { nullPlant: true });
  await world.tap(world.driverUserB, b.trip, 'loaded');
  const loadB = await world.plantLoad(world.plantB, b.order, world.truckB);
  const codes = (
    await migrator.query<{ code: string; ccode: string }>(
      `select o.code, c.code as ccode from sales_order o join client c on c.id = o.client_id where o.id = $1`,
      [b.order],
    )
  ).rows[0]!;
  real = {
    tripB: b.trip,
    tripN: n.trip,
    loadB,
    orderB: b.order,
    orderN: n.order,
    orderCodeB: codes.code,
    clientCode: codes.ccode,
  };
  // one real row of every other kind of target a door can name (an empty table gives a random id: the sweep reports how many)
  for (const [key, table] of Object.entries({
    site: 'client_site',
    zone: 'zone',
    instrument: 'payment_instrument',
    invoice: 'invoice',
    purchase: 'purchase',
    si: 'supplier_invoice',
    survey: 'survey',
    disclosure: 'disclosure_request',
    docreq: 'document_request',
    transfer: 'plant_transfer',
    pumpjob: 'pump_job',
    conflict: 'pump_conflict',
    kase: 'cancellation_case',
    instruction: 'trip_instruction',
    emergency: 'trip_emergency',
    component: 'component',
  })) {
    try {
      real[key] = (await anyId(table)) ?? '';
    } catch (e) {
      console.info('fixture:', String(e));
      real[key] = '';
    }
  }
  // real requests, a real survey, so the doors that name them are called with targets that exist
  const asUser = (u: { id: string; role: string }, sql: string, p: unknown[] = []) =>
    world.as(u, async (tx) => (await tx.query<{ id: string }>(sql, p)).rows[0]?.id as string);
  real.disclosure = await asUser(
    world.sales,
    `select public.request_disclosure('order_total', $1, 'order', $1, 'sweep') as id`,
    [codes.code],
  );
  real.docreq = await asUser(
    world.sales,
    `select public.request_document('releve', 'client', $1, null, null) as id`,
    [codes.ccode],
  );
  real.survey = await asUser(
    world.owner,
    `select public.create_survey('office_sales', 'sweep', $1::jsonb) as id`,
    [JSON.stringify([{ id: 'q1', kind: 'yes_no', text: 'ok?' }])],
  ).catch(() => '');
  // cheap real targets for the doors that name them (a supplier invoice with its purchase, an instrument, a pump job and its conflict, an emergency with an instruction)
  try {
    const si = await world.asOwnerIn(world.plantA, (tx) =>
      newSupplierInvoice(tx, world.owner.id, `dc${randomUUID().slice(0, 6)}`, { receive: false }),
    );
    real.purchase = si.purchaseId;
    real.purchaseCode = si.purchaseCode;
    real.siCode = si.code;
    real.si = (
      await migrator.query<{ id: string }>(`select id::text from supplier_invoice where code = $1`, [si.code])
    ).rows[0]!.id;
  } catch (e) {
    console.info('fixture:', String(e));
    /* reported below as an argument without a real target */
  }
  try {
    real.instrument = (
      await world.asOwnerIn(world.plantA, (tx) =>
        insertInstrument(tx, world.owner.id, { clientId: world.scene.clientId, method: 'cheque' }),
      )
    ).id;
  } catch (e) {
    console.info('fixture:', String(e));
    /* idem */
  }
  try {
    const job = randomUUID();
    await world.sup(
      `insert into pump_job (id, job_date, pump_id, operator_id, site_label, created_by, order_id, plant_id, on_site_min, planned_m3)
       values ($1, $2, $3, $4, 'sweep', $5, $6, $7, 480, 10)`,
      [job, DAY, world.truckA, world.driverA, world.owner.id, real.orderB, world.plantA],
      ['pump_job'],
    );
    real.pumpjob = job;
    real.pump = world.truckA;
    real.conflict = randomUUID();
    await world.sup(
      `insert into pump_conflict (id, kind, job_date, order_id, job_id, plant_id) values ($1, 'pump_double_booked', $2, $3, $4, $5)`,
      [real.conflict, DAY, real.orderB, job, world.plantA],
      ['pump_conflict'],
    );
    real.emergency = randomUUID();
    await world.sup(
      `insert into trip_emergency (id, trip_id, driver_id, step, option, at, client_key) values ($1, $2, $3, 'departed', 'breakdown', now(), $4)`,
      [real.emergency, real.tripB, world.driverB, `k-${randomUUID()}`],
      ['trip_emergency'],
    );
    real.instruction = randomUUID();
    await world.sup(
      `insert into trip_instruction (id, emergency_id, trip_id, kind, created_by) values ($1, $2, $3, 'continue', $4)`,
      [real.instruction, real.emergency, real.tripB, world.owner.id],
      ['trip_instruction'],
    );
  } catch (e) {
    console.info('fixture:', String(e));
    /* idem */
  }
  const rid = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
     values ($1, 'dc reserved', $2, true, 'partner', 'fr', 'active', true, now())`,
    [rid, `dc-reserved-${rid}@kayas.test`],
  );
  reservedUser.id = rid;
});
afterAll(async () => {
  await world
    ?.sup(
      `update pump_conflict set resolved_at = now(), resolved_by = $1 where resolved_at is null and job_date = $2`,
      [world.owner.id, DAY],
      ['pump_conflict'],
    )
    .catch(() => undefined);
  await migrator
    ?.query(`update "user" set status = 'disabled' where id = $1`, [reservedUser.id])
    .catch(() => undefined);
  await world?.done();
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
});

let noTarget = new Set<string>();
/** An argument value: a real existing row where the name says what it is, otherwise the shape's dummy. */
function realArg(fn: string, name: string, type: string, variant: 'B' | 'N'): string {
  const pick = (k: string): string | null => (real[k] ? real[k]! : null);
  const miss = (what: string): string => {
    noTarget.add(`${fn}(${name}) ${what}`);
    return randomUUID();
  };
  if (type === 'uuid') {
    if (/^p_(trip|old|new)$/.test(name)) return variant === 'B' ? real.tripB : real.tripN;
    if (name === 'p_case')
      return /cancel|redirect|ack_redirect|decide_cancellation|open_trip_case/.test(fn)
        ? (pick('kase') ?? miss('case'))
        : variant === 'B'
          ? real.tripB
          : real.tripN;
    if (/^p_(delivery|load)$/.test(name)) return real.loadB;
    if (/^p_order/.test(name)) return variant === 'B' ? real.orderB : real.orderN;
    if (name === 'p_driver' || name === 'p_operator') return world.driverB;
    if (name === 'p_plant') return variant === 'B' ? world.plantB : world.plantA;
    if (name === 'p_client' || name === 'p_type')
      return variant === 'B' ? world.scene.clientId : world.master.typeId;
    if (name === 'p_site') return pick('site') ?? miss('site');
    if (name === 'p_zone') return pick('zone') ?? miss('zone');
    if (name === 'p_pump') return pick('pump') ?? miss('pump');
    if (name === 'p_instrument') return pick('instrument') ?? miss('instrument');
    if (name === 'p_invoice') return pick('invoice') ?? miss('invoice');
    if (name === 'p_purchase') return pick('purchase') ?? miss('purchase');
    if (name === 'p_si') return pick('si') ?? miss('supplier invoice');
    if (name === 'p_job') return pick('pumpjob') ?? miss('pump job');
    if (name === 'p_instruction') return pick('instruction') ?? miss('instruction');
    if (name === 'p_emergency') return pick('emergency') ?? miss('emergency');
    if (name === 'p_file') return pick('file') ?? miss('file');
    if (name === 'p_component') return pick('component') ?? miss('component');
    if (name === 'p_id') {
      if (/survey/.test(fn)) return pick('survey') ?? miss('survey');
      if (/disclosure/.test(fn)) return pick('disclosure') ?? miss('disclosure');
      if (/document/.test(fn)) return pick('docreq') ?? miss('document request');
      if (/transfer/.test(fn)) return pick('transfer') ?? miss('transfer');
      if (/pump_conflict/.test(fn)) return pick('conflict') ?? miss('pump conflict');
      return miss('p_id');
    }
  }
  if (type === 'text') {
    if (name === 'p_order_code') return real.orderCodeB;
    if (name === 'p_purchase_code') return real.purchaseCode || 'x';
    if (name === 'p_code' && /supplier_invoice/.test(fn)) return real.siCode || 'x';
    if (name === 'p_client_code') return real.clientCode;
    if (name === 'p_code' && /set_order_pumped/.test(fn)) return real.orderCodeB;
    if (name === 'p_key') return `k-${randomUUID()}`;
    if (name === 'p_stage' || name === 'p_step') return 'loaded'; // a valid stage, so the refusal under test is the actor's, not the argument's
  }
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type.startsWith('timestamp')) return new Date().toISOString();
  if (type === 'uuid[]') return `{${randomUUID()}}`;
  if (type === 'text[]') return '{owner}';
  return dummy(type);
}

const dummy = (t: string): string => {
  if (t === 'uuid') return randomUUID();
  if (t === 'date') return '2092-01-01';
  if (t.startsWith('timestamp')) return '2092-01-01T00:00:00Z';
  if (t === 'boolean') return 'false';
  if (/^(integer|bigint|smallint|numeric|double precision|real)$/.test(t)) return '1';
  if (t === 'jsonb' || t === 'json') return '{}';
  if (t.endsWith('[]')) return '{}';
  return 'x';
};

const CONTEXTS = (): { label: string; role: string | null; user: string | null }[] => [
  { label: 'unset role, no user', role: null, user: null },
  { label: 'unset role, a REAL plant manager user id', role: null, user: world.pmA.id },
  { label: 'unset role, a REAL driver user id', role: null, user: world.driverUserA.id },
  { label: 'empty role, a real user id', role: '', user: world.pmA.id },
  { label: 'unknown role', role: 'bogus', user: randomUUID() },
  {
    label: "a role that is not the user's (owner claimed by a plant manager)",
    role: 'owner',
    user: world.pmA.id,
  },
  {
    label: 'a RESERVED role of a stored reserved account (boundary ON)',
    role: 'partner',
    user: reservedUser.id,
  },
  { label: 'anonymous', role: 'anonymous', user: '00000000-0000-7000-8000-000000000000' },
  { label: 'a role no account has', role: 'client_portal', user: randomUUID() },
];

describe('R19-01 (d): the sweep with real targets — the exact refusal, nothing answered, nothing written', () => {
  it('every application-executable business door refuses (SQLSTATE 42501) a request without a valid actor, for real targets of another plant and of none', async () => {
    noTarget = new Set();
    const fns = (await catalogue()).filter(
      (f) =>
        f.app &&
        !PUBLIC_BY_DESIGN[f.name] &&
        !INTERNAL_PREDICATES.includes(f.name) &&
        !AUTH_CREDENTIAL_DOORS.includes(f.name),
    );
    expect(fns.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const fn of fns) {
      for (const [variant, ctxCase] of CONTEXTS().flatMap((c) =>
        (['B', 'N'] as const).map((v) => [v, c] as const),
      )) {
        const c = await app.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [
            ctxCase.role ?? '',
            ctxCase.user ?? '',
          ]);
          const params = fn.args.map((_, i) => `$${i + 1}::${fn.args[i]}`).join(', ');
          const call = fn.retset
            ? `select count(*)::text as r from ${fn.name}(${params})`
            : `select ${fn.name}(${params})::text as r`;
          const where = `${fn.name} for: ${ctxCase.label} (${variant} targets)`;
          let outcome:
            { kind: 'refused'; code: string; message: string } | { kind: 'answered'; answer: string | null };
          try {
            const res = await c.query<{ r: string | null }>(
              call,
              fn.args.map((t, i) => realArg(fn.name, fn.argNames[i] ?? '', t, variant)),
            );
            outcome = { kind: 'answered', answer: res.rows[0]?.r ?? null };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            outcome = { kind: 'refused', code: err.code ?? '?', message: err.message ?? '' };
          }
          if (outcome.kind === 'refused') {
            if (outcome.code !== '42501')
              offenders.push(
                `${where}: refused with ${outcome.code} (${outcome.message.slice(0, 70)}), not 42501`,
              );
          } else if (!ANSWERS_EMPTY[fn.name]) {
            offenders.push(`${where}: ANSWERED "${String(outcome.answer).slice(0, 40)}" instead of refusing`);
          }
          if (outcome.kind === 'answered') {
            const w = await c.query<{ x: string | null }>(
              'select pg_current_xact_id_if_assigned()::text as x',
            );
            if (w.rows[0]?.x) offenders.push(`${where}: WROTE`);
          }
        } finally {
          await c.query('rollback').catch(() => undefined);
          c.release();
        }
      }
    }
    // The kinds below have no cheap fixture: each is exercised with a real row by its own suite (reason beside it); the sweep still sends the door a valid shape.
    const KNOWN_WITHOUT_TARGET: Record<string, string> = {
      'finance.link_state(p_id)':
        'a finance link id: the finance module has its own suite (finance.int.test.ts)',
      'public.allocate_to_invoice(p_invoice)':
        'an invoice needs a delivered, billed load: allocation-invoices.int.test.ts',
      'public.invoice_print(p_invoice)': 'idem: invoice.int.test.ts',
      'public.attach_supplier_invoice_file(p_file)': 'a stored file id: supplier-invoice file suites',
      'public.driver_attach_bl_photo(p_file)': 'a stored file id: driver-bl-photo.int.test.ts',
      'public.create_order(p_site)': 'a client site: order suites',
      'public.decide_cancellation(p_case)':
        'a cancellation case needs a rotation in a stage: cancellations.int.test.ts',
      'public.driver_ack_redirect(p_case)': 'idem',
      'public.redirect_candidates(p_case)': 'idem',
      'public.transfer_pickup(p_id)': 'a plant transfer needs stock: transfers suite',
      'public.transfer_receive(p_id)': 'idem',
      'public.end_sms_sender(p_id)':
        'a registered sender needs a driver and a sealed number: tests/t15-vehicle-registry.int.test.ts',
    };
    const unexplained = [...noTarget].filter(
      (x) => !Object.keys(KNOWN_WITHOUT_TARGET).some((k) => x.startsWith(k)),
    );
    expect(unexplained, 'an argument lost its real target').toEqual([]);
    // how many arguments had no real row to point at: reported, and bounded so a regression of the fixtures is visible
    console.info(
      `definer sweep: ${noTarget.size} argument(s) without a real target:\n  ${[...noTarget].join('\n  ')}`,
    );
    expect(offenders).toEqual([]);
    for (const k of Object.keys(ANSWERS_EMPTY))
      expect(
        fns.map((f) => f.name),
        `stale ANSWERS_EMPTY ${k}`,
      ).toContain(k);
  });

  it('the helper itself: refuses every non-actor exactly, answers the role of a real admitted actor', async () => {
    const run = async (role: string | null, user: string | null) => {
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [
          role ?? '',
          user ?? '',
        ]);
        return (await c.query<{ r: string }>(`select ctx.require_admitted_actor('probe') as r`)).rows[0]!.r;
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    for (const [role, user] of [
      [null, world.pmA.id],
      ['', world.pmA.id],
    ] as const)
      await expect(run(role, user)).rejects.toMatchObject({
        code: '42501',
        message: 'probe: not an admitted actor',
      });
    await expect(run('plant_manager', null)).rejects.toMatchObject({ code: '42501' });
    for (const [role, user] of [
      ['owner', world.pmA.id],
      ['partner', reservedUser.id],
      ['anonymous', '00000000-0000-7000-8000-000000000000'],
      ['system', '00000000-0000-7000-8000-000000000001'],
    ] as const)
      await expect(run(role, user), `${role}`).rejects.toMatchObject({ code: '42501' });
    expect(await run('plant_manager', world.pmA.id)).toBe('plant_manager');
    expect(await run('driver', world.driverUserA.id)).toBe('driver');
  });
});

describe('R18-02: the shape that failed cannot come back', () => {
  it('no business definer guards a lookup with `IF NOT FOUND OR NOT (<role test>)` unless it validates the actor first', async () => {
    const { rows } = await migrator.query<{ name: string; src: string }>(
      `select n.nspname || '.' || p.proname as name, p.prosrc as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and p.prokind = 'f' and n.nspname in ('public', 'ctx', 'finance', 'history')`,
    );
    const risky = rows.filter(
      (r) =>
        /IF\s+NOT\s+FOUND\s+OR[^;]*NOT\s*\(\s*v_role\s+IN/i.test(r.src) ||
        /IF[^;]*\bOR\s+NOT\s*\(\s*(?:v_role|ctx\.actor_role\(\))\s+IN/i.test(r.src),
    );
    // a risky shape is allowed only behind the shared actor-first helper or an explicit IS NULL / IS NOT TRUE test of the role
    const offenders = risky.filter(
      (r) => !/ctx\.require_actor\(|actor_role\(\) IS NULL|v_role IS NULL|IS NOT TRUE/i.test(r.src),
    );
    expect(offenders.map((o) => o.name)).toEqual([]);
    // and the four doors of R18-02 use the helper
    for (const door of [
      'attach_trip_load',
      'confirm_trip_delivered',
      'confirm_trip_stage',
      'correct_trip_stage',
    ])
      expect(rows.find((r) => r.name === `public.${door}`)?.src, door).toMatch(/ctx\.require_actor\(/);
  });

  it('the shared helpers refuse a NULL role and do not return NULL for a scope test', async () => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true), set_config('app.role', '', true)`, [
        world.pmA.id,
      ]);
      await expect(c.query(`select ctx.require_actor('t', array['owner'])`)).rejects.toMatchObject({
        code: '42501',
      });
      await c.query('rollback');
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true), set_config('app.role', '', true)`, [
        world.pmA.id,
      ]);
      const r = await c.query<{ v: boolean | null }>(`select ctx.in_actor_scope(array['owner'], null) as v`);
      expect(r.rows[0]!.v).toBe(false);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });
});
