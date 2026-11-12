import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { businessDateOf, realClock } from '../src/modules/clock';
import { createPlant, createTruck, updatePlant } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { testEnv } from './db-env';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  type DeliveryScene,
} from './helpers/ledger-fixtures';
import { getInvoiceQueue } from '../src/modules/ledger';
import { countHeldDeliveries, listDeliveryExceptions } from '../src/modules/operations';
import { v1Actors } from './helpers/v1-actors';
import { freeDriverCode } from './helpers/codes';

// T9 (docs/T9-TRIP-SHARED-STATUS.md): ONE shared status of a rotation, written by the driver and by the plant through record_trip_stage.
// Forward-only with an implicit fill, idempotent and race-safe, corrections as new rows, authorization in the database, and a driver's
// tap that changes no stock, delivery, delivered mark or invoice figure.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 14 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `tg${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const DAY: string = businessDateOf(realClock.now());
const STAGES = [
  'loading_started',
  'loaded',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;

let done: () => Promise<void>;
let owner: SessionUser, pmA: SessionUser, pmB: SessionUser, appAdmin: SessionUser;
let partner: SessionUser, support: SessionUser, sales: SessionUser, accountant: SessionUser;
let driver1: SessionUser, driver2: SessionUser;
let plantA = '',
  plantB = '';
let scene: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
let truckA = '',
  truckB = '',
  truckN = '';
let driverRow1 = '',
  driverRow2 = '';

const asOwner = <T>(plant: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plant]);
    return fn(tx);
  });
const asRole = <T>(u: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);

async function superRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  replica = false,
): Promise<T[]> {
  const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
  await c.connect();
  try {
    await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
      SYSTEM_ACTOR_ID,
    ]);
    if (replica) await c.query('set session_replication_role = replica');
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function userRow(role: string, plant: string | null): Promise<SessionUser> {
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, $4, 'fr', 'active', true, now(), $5)`,
    [id, `${marker} ${role}`, `${marker}-${role}-${id}@kayas.test`, role, plant],
  );
  return {
    id,
    name: `${marker} ${role}`,
    email: `${id}@kayas.test`,
    role,
    locale: 'fr',
    twoFactorEnabled: true,
    reenrolRequired: false,
  } as unknown as SessionUser;
}
async function newDriver(name: string, user: SessionUser): Promise<string> {
  const code = await freeDriverCode();
  return (
    await superRows<{ id: string }>(
      `insert into driver (id, code, name, created_by, kind, user_id) values (gen_random_uuid(), $1, $2, $3, 'driver', $4) returning id`,
      [code, name, owner.id, user.id],
    )
  )[0]!.id;
}
async function newTrip(
  plant: string,
  truckId: string,
  driverId: string | null,
  loadMin = 420,
  day = DAY,
): Promise<string> {
  return asOwner(plant, async (tx) => {
    const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, day);
    const id = randomUUID();
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, $6, 1000, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        randomUUID(),
        day,
        o.id,
        truckId,
        driverId,
        loadMin,
        loadMin + 10,
        loadMin + 40,
        loadMin + 80,
        loadMin + 110,
        owner.id,
      ],
    );
    return id;
  });
}
const orderOf = async (trip: string) =>
  (await superRows<{ order_id: string }>(`select order_id from trip_plan where id = $1`, [trip]))[0]!
    .order_id;

interface Out {
  o_stage: string;
  o_recorded: boolean;
  o_at: Date;
  o_source: string;
  o_actor_role: string;
  o_implicit: boolean;
  o_delivery_id: string | null;
}
const record = (
  u: SessionUser,
  trip: string,
  stage: string,
  o: { now?: Date; client?: Date | null; key?: string | null; delivery?: string | null } = {},
) =>
  asRole(
    u,
    async (tx) =>
      (
        await tx.query<Out>('select * from public.record_trip_stage($1, $2, $3, $4, $5, $6)', [
          trip,
          stage,
          o.now ?? new Date(),
          o.client ?? null,
          o.key ?? null,
          o.delivery ?? null,
        ])
      ).rows[0]!,
  );
const tap = (
  u: SessionUser,
  trip: string,
  step: string,
  at = new Date(),
  key = `k-${randomUUID()}`,
  vol: number | null = null,
) =>
  asRole(
    u,
    async (tx) =>
      (
        await tx.query<{ r: string }>('select public.driver_report($1, $2, $3, $4, $5, $6) as r', [
          trip,
          step,
          at,
          key,
          vol,
          null,
        ])
      ).rows[0]!.r,
  );
interface Stored {
  step: string;
  at: Date;
  source: string;
  actor_role: string | null;
  implicit: boolean;
  client_time: Date | null;
  client_key: string | null;
  delivery_id: string | null;
  created_by: string;
}
const stored = (trip: string) =>
  superRows<Stored>(
    `select step, at, source, actor_role, implicit, client_time, client_key, delivery_id, created_by from trip_event where trip_id = $1
      order by array_position(array['loading_started','loaded','departed','arrived','unloading_started','unloading_finished','back'], step)`,
    [trip],
  );
const stepsOf = async (trip: string) =>
  (await stored(trip))
    .map((r) => r.step)
    .sort((a, b) => STAGES.indexOf(a as never) - STAGES.indexOf(b as never));
const denied = async (p: Promise<unknown>, code = '42501') => {
  try {
    await p;
    return false;
  } catch (e) {
    return (e as { code?: string }).code === code;
  }
};
const stagesFor = (u: SessionUser, date = DAY) =>
  asRole(
    u,
    async (tx) =>
      (
        await tx.query<{
          trip_id: string;
          step: string;
          at: Date;
          source: string;
          implicit: boolean;
          client_time: Date | null;
          corrected_at: Date | null;
          load_linked: boolean;
        }>('select * from public.trip_stages($1)', [date])
      ).rows,
  );
/** The plant's own load of a rotation: a delivery of its order on its truck (BL, stock), as the plant's tracking creates it. */
const plantLoad = (plant: string, trip: string, truckId: string) =>
  asOwner(plant, async (tx) => {
    const orderId = await orderOf(trip);
    const d = await insertDelivery(tx, owner.id, { orderId, truckId, recetteId: scene.recetteId }, 1000);
    return (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo])).rows[0]!.id;
  });

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantA = v.plantId;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  appAdmin = v.session('app_admin') as unknown as SessionUser;
  partner = v.session('partner') as unknown as SessionUser;
  support = v.session('support') as unknown as SessionUser;
  sales = v.session('office_sales') as unknown as SessionUser;
  accountant = v.session('accountant') as unknown as SessionUser;
  master = await orderMaster(app, owner.id, `${marker}a`);
  scene = await deliveryScene(app, owner.id, `${marker}a`, DAY);
  const b = await createPlant(app, owner, { code: letters(6), name: `TSB ${marker}` });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  pmB = await userRow('plant_manager', plantB);
  driver1 = await userRow('driver', null);
  driver2 = await userRow('driver', null);
  driverRow1 = await newDriver(`Chauffeur un ${marker}`, driver1);
  driverRow2 = await newDriver(`Chauffeur deux ${marker}`, driver2);
  const mk = async (plant: string | null, tag: string) => {
    for (let i = 0; i < 30; i++) {
      const r = await createTruck(app, owner, {
        code: `${plant === null ? 'X' : 'T'}${100 + Math.floor(Math.random() * 890)}`,
        plate: `TS-${marker.slice(0, 8)}-${tag}${i}`,
        plantId: plant,
        kind: plant === null ? 'external' : 'mixer',
      });
      if (r.ok) return r.value.id;
    }
    throw new Error('no truck code');
  };
  truckA = await mk(plantA, 'a');
  truckB = await mk(plantB, 'b');
  truckN = await mk(null, 'n');
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

const YESTERDAY = new Date(Date.parse(`${DAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const gateOf = (load: string) =>
  superRows<{ via: string; created_by: string }>(
    `select via, created_by from delivery_delivered where delivery_id = $1`,
    [load],
  );
const confirmStage = (u: SessionUser, trip: string, stage: string) =>
  asRole(
    u,
    async (tx) =>
      (
        await tx.query<{ c: boolean }>('select public.confirm_trip_stage($1, $2, $3) as c', [
          trip,
          stage,
          new Date(),
        ])
      ).rows[0]!.c,
  );
interface Exc {
  kind: string;
  trip_id: string;
  plant_volume_l: number | null;
  declared_volume_l: number | null;
  planned_volume_l: number | null;
}
const exceptionsFor = (u: SessionUser, from = YESTERDAY, to = DAY) =>
  asRole(
    u,
    async (tx) =>
      (await tx.query<Exc>('select * from public.trip_delivery_exceptions($1, $2)', [from, to])).rows,
  );
/** A rotation taken to the end of the unloading by the driver (the m3 he declares); the plant's own load is linked to it unless `link` is false. */
async function unloadedTrip(opts: { day?: string; link?: boolean; declared?: number } = {}) {
  const trip = await newTrip(plantA, truckA, driverRow1, 420, opts.day ?? DAY);
  await tap(driver1, trip, 'loaded');
  let load: string | null = null;
  if (opts.link !== false) {
    load = await plantLoad(plantA, trip, truckA);
    await asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load]));
  }
  for (const s of ['departed', 'arrived', 'unloading_started']) await tap(driver1, trip, s);
  await tap(driver1, trip, 'unloading_finished', new Date(), `k-${randomUUID()}`, opts.declared ?? 1000);
  return { trip, load };
}

describe('T9b: the driver\'s unloading is the operational "delivered"; the billing gate stays the plant\'s', () => {
  it("a driver's whole rotation changes no stock row, no billing gate, no invoice-queue line and no queue amount", async () => {
    const snapshot = async () => ({
      queue: JSON.stringify(await getInvoiceQueue(app, owner)),
      stock: (
        await superRows(
          `select count(*)::int n, coalesce(sum(qty_base),0)::text q from stock_movement where source = 'delivery'`,
        )
      )[0],
      gate: (await superRows(`select count(*)::int n from delivery_delivered`))[0],
    });
    const trip = await newTrip(plantA, truckA, driverRow1);
    const load = await plantLoad(plantA, trip, truckA);
    await tap(driver1, trip, 'loaded');
    await asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load]));
    const before = await snapshot();
    for (const s of ['departed', 'arrived', 'unloading_started']) await tap(driver1, trip, s);
    await tap(driver1, trip, 'unloading_finished', new Date(), `k-${randomUUID()}`, 1000);
    await tap(driver1, trip, 'back');
    expect(await snapshot()).toEqual(before);
    expect(await gateOf(load)).toHaveLength(0);
    // the operational mark is there, as the driver's: the stage row says so
    const stages = await stagesFor(pmA);
    expect(stages.find((x) => x.trip_id === trip && x.step === 'unloading_finished')).toMatchObject({
      source: 'driver',
      implicit: false,
    });
    // the driver can neither confirm the delivery nor confirm a stage
    expect(
      await denied(asRole(driver1, (tx) => tx.query('select public.confirm_trip_delivered($1)', [trip]))),
    ).toBe(true);
    expect(
      await denied(
        asRole(driver1, (tx) => tx.query('select public.confirm_trip_stage($1, $2, now())', [trip, 'back'])),
      ),
    ).toBe(true);
  });

  it("the plant confirming the RETURN sets the gate exactly once, by that user, with the way noted; the billable quantity is the plant's load, not the driver's", async () => {
    const { trip, load } = await unloadedTrip({ declared: 3500 }); // the driver says 3.5 m3, the plant loaded 1 m3
    await tap(driver1, trip, 'back'); // the driver declares his return: still no gate
    expect(await gateOf(load!)).toHaveLength(0);
    expect(
      await denied(
        asRole(pmB, (tx) => tx.query('select public.confirm_trip_stage($1, $2, now())', [trip, 'back'])),
      ),
    ).toBe(true);
    expect(await confirmStage(pmA, trip, 'back')).toBe(true);
    expect(await gateOf(load!)).toEqual([{ via: 'return', created_by: pmA.id }]);
    expect(await confirmStage(pmA, trip, 'back')).toBe(false); // idempotent
    expect(
      await asRole(
        pmA,
        async (tx) =>
          (await tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [trip])).rows[0]!
            .c,
      ),
    ).toBe(false);
    expect(await gateOf(load!)).toHaveLength(1);
    // the audit log has the gate row with its actor
    const audit = await superRows<{ actor_user_id: string; table_name: string }>(
      `select actor_user_id, table_name from audit_event
        where table_name in ('delivery_delivered', 'trip_event_confirmation') and (after->>'delivery_id' = $1 or after->>'trip_id' = $2)`,
      [load, trip],
    );
    expect(audit.some((a) => a.table_name === 'delivery_delivered' && a.actor_user_id === pmA.id)).toBe(true);
    expect(audit.some((a) => a.table_name === 'trip_event_confirmation' && a.actor_user_id === pmA.id)).toBe(
      true,
    );
    // the queue shows the plant's quantity (1000 L), whatever the driver declared
    const line = (await getInvoiceQueue(app, owner))
      .flatMap((c) => c.deliveries)
      .find((d) => d.deliveryId === load);
    expect(line?.volumeL).toBe(1000);
  });

  it('the plant recording the return itself does the same, once; a filled-in unloading or a missing plant load sets no gate', async () => {
    const { trip, load } = await unloadedTrip();
    await record(pmA, trip, 'back');
    expect(await gateOf(load!)).toEqual([{ via: 'return', created_by: pmA.id }]);
    await record(pmA, trip, 'back');
    expect(await gateOf(load!)).toHaveLength(1);
    // the plant jumps to "back" with no unloading declared: the unloading is filled in, nothing is delivered
    const t2 = await newTrip(plantA, truckA, driverRow1, 450);
    const load2 = await plantLoad(plantA, t2, truckA);
    await record(pmA, t2, 'loaded', { delivery: load2 });
    await record(pmA, t2, 'back');
    expect(await gateOf(load2)).toHaveLength(0);
    // declared unloading, no plant load: the return sets nothing
    const t3 = await unloadedTrip({ link: false });
    await record(pmA, t3.trip, 'back');
    expect(
      await superRows(
        `select 1 from delivery_delivered d join trip_event e on e.delivery_id = d.delivery_id where e.trip_id = $1`,
        [t3.trip],
      ),
    ).toHaveLength(0);
  });

  it('the explicit confirmation stays available (a truck that does not come back) and says how', async () => {
    const { trip, load } = await unloadedTrip();
    expect(
      await asRole(
        appAdmin,
        async (tx) =>
          (await tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [trip])).rows[0]!
            .c,
      ),
    ).toBe(true);
    expect(await gateOf(load!)).toEqual([{ via: 'confirm', created_by: appAdmin.id }]);
  });
});

describe('T9b: the plant is the authority for departed and back; the driver may declare them', () => {
  it("a driver's departed is awaiting the plant; the plant's confirmation is the time the timing board uses; only departed and back can be confirmed", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1, 420);
    const phone = new Date(Date.now() - 10 * 60_000);
    await asRole(driver1, (tx) =>
      tx.query('select public.driver_report($1, $2, $3, $4, null, null)', [
        trip,
        'departed',
        phone,
        `k-${randomUUID()}`,
      ]),
    );
    expect(await confirmStage(pmA, trip, 'departed')).toBe(true);
    expect(await confirmStage(pmA, trip, 'departed')).toBe(false);
    expect(
      await denied(
        asRole(pmA, (tx) => tx.query('select public.confirm_trip_stage($1, $2, now())', [trip, 'arrived'])),
        '23514',
      ),
    ).toBe(true);
    const row = (await stagesFor(pmA)).find((r) => r.trip_id === trip && r.step === 'departed')!;
    expect(row.source).toBe('driver');
    const timing = await asRole(
      pmA,
      async (tx) =>
        (
          await tx.query<{ trip_id: string; steps: { step: string; at: string }[] }>(
            'select trip_id, steps from public.trip_timing($1)',
            [DAY],
          )
        ).rows,
    );
    const dep = timing.find((r) => r.trip_id === trip)!.steps.find((s) => s.step === 'departed')!;
    const confirmed = (
      await superRows<{ confirmed_at: Date }>(
        `select confirmed_at from trip_event_confirmation where trip_id = $1`,
        [trip],
      )
    )[0]!;
    expect(new Date(dep.at).getTime()).toBe(confirmed.confirmed_at.getTime()); // the plant's time, not the phone's
    // a stage the plant recorded itself needs no confirmation
    const t2 = await newTrip(plantA, truckA, driverRow1, 460);
    await record(pmA, t2, 'departed');
    expect(await confirmStage(pmA, t2, 'departed')).toBe(false);
  });
});

describe('T9b: the exception lists (flag only, scoped)', () => {
  it('declared with no plant record; unconfirmed after the end of the working day; volume differs', async () => {
    const noRecord = await unloadedTrip({ link: false, day: YESTERDAY });
    const late = await unloadedTrip({ day: YESTERDAY, declared: 1000 });
    const differs = await unloadedTrip({ day: YESTERDAY, declared: 4200 });
    const fine = await unloadedTrip({ day: DAY, declared: 1000 });
    const seen = await exceptionsFor(owner);
    const kinds = (trip: string) => seen.filter((x) => x.trip_id === trip).map((x) => x.kind);
    expect(kinds(noRecord.trip)).toContain('declared_no_record');
    expect(kinds(late.trip)).toContain('unconfirmed'); // yesterday is past the end of its working day
    expect(kinds(late.trip)).not.toContain('volume_differs');
    expect(kinds(differs.trip)).toContain('volume_differs');
    expect(seen.find((x) => x.trip_id === differs.trip && x.kind === 'volume_differs')).toMatchObject({
      plant_volume_l: 1000,
      declared_volume_l: 4200,
    });
    expect(kinds(fine.trip)).not.toContain('volume_differs');
  });

  it('the plant load against the planned volume of the rotation is flagged too', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1, 470, YESTERDAY);
    await tap(driver1, trip, 'loaded');
    const load = await asOwner(plantA, async (tx) => {
      const d = await insertDelivery(
        tx,
        owner.id,
        { orderId: await orderOf(trip), truckId: truckA, recetteId: scene.recetteId },
        2500,
      );
      return (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo])).rows[0]!
        .id;
    });
    await asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load]));
    for (const s of ['departed', 'arrived', 'unloading_started']) await tap(driver1, trip, s);
    await tap(driver1, trip, 'unloading_finished', new Date(), `k-${randomUUID()}`, 2500);
    const seen = await exceptionsFor(pmA);
    expect(seen.find((x) => x.trip_id === trip && x.kind === 'volume_differs')).toMatchObject({
      plant_volume_l: 2500,
      planned_volume_l: 1000,
    });
  });

  it("nothing is corrected: the exception rows leave the plant's load, the stages and the gate exactly as they were", async () => {
    const { trip, load } = await unloadedTrip({ day: YESTERDAY, declared: 4200 });
    const snap = async () =>
      JSON.stringify([
        await stored(trip),
        await superRows(`select volume_l from delivery where id = $1`, [load]),
        await gateOf(load!),
      ]);
    const before = await snap();
    await exceptionsFor(owner);
    await exceptionsFor(pmA);
    expect(await snap()).toBe(before);
  });

  it("a plant manager sees his plant's exceptions only; owner and app_admin all; a driver and the other roles none", async () => {
    const mine = await unloadedTrip({ link: false, day: YESTERDAY });
    const ids = (rows: { trip_id: string }[]) => new Set(rows.map((r) => r.trip_id));
    expect(ids(await exceptionsFor(pmA)).has(mine.trip)).toBe(true);
    expect(ids(await exceptionsFor(pmB)).has(mine.trip)).toBe(false);
    for (const u of [owner, appAdmin]) expect(ids(await exceptionsFor(u)).has(mine.trip)).toBe(true);
    for (const u of [driver1, partner, support, sales, accountant])
      expect(await denied(exceptionsFor(u)), u.role).toBe(true);
    const r = await listDeliveryExceptions(app, pmA, { from: YESTERDAY, to: DAY });
    expect(r.ok && r.value.some((x) => x.tripId === mine.trip && x.kind === 'declared_no_record')).toBe(true);
  });

  it('the held COUNT (a number only) is visible to office_sales, who cannot read the details; plant side and owners as before; the others are refused', async () => {
    const mine = await unloadedTrip({ link: false, day: YESTERDAY });
    const range = { from: YESTERDAY, to: DAY };
    const held = async (u: SessionUser) => {
      const r = await countHeldDeliveries(app, u, range);
      return r.ok ? r.value : null;
    };
    const detailsOf = async (u: SessionUser) =>
      (await exceptionsFor(u)).filter((x) => x.kind === 'declared_no_record' || x.kind === 'unconfirmed')
        .length;
    // the details stay closed to the office
    expect(await denied(exceptionsFor(sales))).toBe(true);
    await expect(listDeliveryExceptions(app, sales, range)).rejects.toThrow();
    // the count is a number, the same one the owner's details add up to, and carries nothing else
    const n = await held(sales);
    expect(typeof n).toBe('number');
    expect(n).toBe(await detailsOf(owner));
    expect(n).toBeGreaterThan(0);
    const wire = JSON.stringify(await countHeldDeliveries(app, sales, range));
    for (const needle of [mine.trip, 'CMD', 'T1', 'driver', 'client']) expect(wire).not.toContain(needle);
    expect(await held(owner)).toBe(n);
    expect(await held(appAdmin)).toBe(n);
    // the plant side is scoped by the database as the details are: manager B sees none of A's
    const rows = await asRole(pmB, (tx) =>
      tx.query<{ n: number }>('select public.trip_delivery_held_count($1, $2) as n', [YESTERDAY, DAY]),
    );
    expect(rows.rows[0]!.n).toBe(await detailsOf(pmB));
    expect(rows.rows[0]!.n).toBeLessThan(n as number);
    // roles that do not work the queue, a driver and a missing actor: refused
    for (const u of [driver1, accountant])
      expect(
        await denied(
          asRole(u, (tx) => tx.query('select public.trip_delivery_held_count($1, $2)', [YESTERDAY, DAY])),
        ),
        u.role,
      ).toBe(true);
    await expect(countHeldDeliveries(app, accountant, range)).rejects.toThrow();
  });

  it('the invoice queue shows nothing of a driver-declared delivery with no plant load, nor of one not yet through the gate', async () => {
    const noRecord = await unloadedTrip({ link: false });
    const waiting = await unloadedTrip();
    const queue = (await getInvoiceQueue(app, owner)).flatMap((c) => c.deliveries.map((d) => d.deliveryId));
    expect(queue).not.toContain(waiting.load);
    expect(JSON.stringify(queue)).not.toContain(noRecord.trip);
  });
});

describe("T9b: the company phone for the driver's tel: link", () => {
  it('is readable by the driver and the plant side, by nobody else', async () => {
    const phone = (u: SessionUser) =>
      asRole(
        u,
        async (tx) =>
          (await tx.query<{ p: string | null }>('select public.company_contact_phone() as p')).rows[0]!.p,
      );
    for (const u of [driver1, pmA, owner]) await expect(phone(u), u.role).resolves.toBeDefined();
    for (const u of [partner, support, sales, accountant]) expect(await denied(phone(u)), u.role).toBe(true);
  });
});
