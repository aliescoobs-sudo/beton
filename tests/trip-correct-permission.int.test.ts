import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { businessDateOf, realClock } from '../src/modules/clock';
import { createPlant, createTruck, setPlantPhone, updatePlant } from '../src/modules/master-data';
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
import { correctTripStage, postponeTrip, reassignTrip, saveDispatch } from '../src/modules/operations';
import { can, ForbiddenError } from '../src/modules/platform-security';
import { v1Actors } from './helpers/v1-actors';
import { freeDriverCode } from './helpers/codes';

// T9 (docs/T9-TRIP-SHARED-STATUS.md): ONE shared status of a rotation, written by the driver and by the plant through record_trip_stage.
// Forward-only with an implicit fill, idempotent and race-safe, corrections as new rows, authorization in the database, and a driver's
// tap that changes no stock, delivery, delivered mark or invoice figure.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 14 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `tc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
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
let purchases: SessionUser, pumpOp: SessionUser;
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
  purchases = v.session('office_purchases') as unknown as SessionUser;
  pumpOp = v.session('pump_operator') as unknown as SessionUser;
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

const confirmStage = (u: SessionUser, trip: string, stage: string) =>
  asRole(u, (tx) => tx.query('select public.confirm_trip_stage($1, $2, now())', [trip, stage]));
const exceptionsFor = (u: SessionUser) =>
  asRole(u, (tx) => tx.query('select * from public.trip_delivery_exceptions($1, $1)', [DAY]));
const correct = (u: SessionUser, trip: string, stage: string, when: Date, reason: string | null) =>
  asRole(u, (tx) =>
    tx.query('select public.correct_trip_stage($1, $2, $3, $4)', [trip, stage, when, reason]),
  );

describe('T9b addendum: the narrow right to correct a stage (trips.correct)', () => {
  it("office_sales corrects the time of a stage of ANY plant's rotation with a reason: a superseding row, audited; without a reason it is refused", async () => {
    const a = await newTrip(plantA, truckA, driverRow1);
    const b = await newTrip(plantB, truckB, driverRow2);
    for (const [trip, d] of [
      [a, driver1],
      [b, driver2],
    ] as const) {
      await record(d, trip, 'loading_started', { now: new Date(Date.now() - 30 * 60_000) });
      await correct(
        sales,
        trip,
        'loading_started',
        new Date(Date.now() - 20 * 60_000),
        'Heure relue sur le bon',
      );
    }
    const rows = await superRows<{ actor_role: string; actor_id: string; reason: string }>(
      `select actor_role, actor_id, reason from trip_event_correction where trip_id = any($1) order by created_at`,
      [[a, b]],
    );
    expect(rows.map((r) => [r.actor_role, r.actor_id, r.reason])).toEqual([
      ['office_sales', sales.id, 'Heure relue sur le bon'],
      ['office_sales', sales.id, 'Heure relue sur le bon'],
    ]);
    const audit = await superRows<{ actor_user_id: string }>(
      `select actor_user_id from audit_event where action = 'reverse' and table_name = 'trip_event' and reason = 'Heure relue sur le bon' and actor_user_id = $1`,
      [sales.id],
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
    for (const bad of [null, '', 'ab', ' marge ']) {
      expect(await denied(correct(sales, a, 'loading_started', new Date(), bad), '23514'), String(bad)).toBe(
        true,
      );
    }
    // the stage itself is untouched and nothing was deleted
    expect((await stored(a)).map((r) => r.step)).toEqual(['loading_started']);
  });

  it('the service door: office_sales is allowed, and the roles without the right are refused (office_purchases, accountant, driver, pump_operator)', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(driver1, trip, 'loading_started', { now: new Date(Date.now() - 30 * 60_000) });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(
      await correctTripStage(app, sales, {
        tripId: trip,
        step: 'loading_started',
        at,
        reason: 'Relu au bon',
      }),
    ).toEqual({ ok: true, value: { at } });
    for (const u of [purchases, accountant, driver1, pumpOp]) {
      await expect(
        correctTripStage(app, u, { tripId: trip, step: 'loading_started', at, reason: 'Essai' }),
        u.role,
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await denied(correct(u, trip, 'loading_started', new Date(), 'Essai')), u.role).toBe(true);
    }
    expect(await superRows(`select 1 from trip_event_correction where trip_id = $1`, [trip])).toHaveLength(1);
  });

  it('office_sales gets no other power: it cannot plan, reassign or postpone, record or confirm a stage, read the board or the exceptions', async () => {
    for (const permission of ['dispatch.write', 'dispatch.read', 'trips.track', 'trips.read'] as const) {
      expect(can('office_sales', permission), permission).toBe(false);
    }
    expect(can('office_sales', 'trips.correct')).toBe(true);
    for (const role of [
      'office_purchases',
      'accountant',
      'driver',
      'pump_operator',
      'partner',
      'support',
    ] as const)
      expect(can(role, 'trips.correct'), role).toBe(false);
    const trip = await newTrip(plantA, truckA, driverRow1);
    await expect(
      reassignTrip(app, sales, { tripId: trip, truckId: truckB, driverId: null, reason: 'Essai' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(postponeTrip(app, sales, { tripId: trip, reason: 'Essai' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(saveDispatch(app, sales, { date: DAY, rotations: [] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await denied(record(sales, trip, 'loading_started'))).toBe(true);
    expect(await denied(confirmStage(sales, trip, 'departed'))).toBe(true);
    expect(await denied(exceptionsFor(sales))).toBe(true);
    expect(await denied(stagesFor(sales))).toBe(true);
    expect(await stepsOf(trip)).toEqual([]);
  });

  it("a plant manager still corrects his own plant's rotations only", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(driver1, trip, 'loading_started', { now: new Date(Date.now() - 30 * 60_000) });
    expect(await denied(correct(pmB, trip, 'loading_started', new Date(), 'Autre centrale'))).toBe(true);
    await correct(pmA, trip, 'loading_started', new Date(Date.now() - 20 * 60_000), 'Ma centrale');
    expect(await superRows(`select 1 from trip_event_correction where trip_id = $1`, [trip])).toHaveLength(1);
  });
});

describe('T9b addendum: the phone number of a plant', () => {
  const phoneOf = async (plant: string) =>
    (await superRows<{ phone: string | null }>(`select phone from plant where id = $1`, [plant]))[0]!.phone;

  it('only the owner and app_admin set it (audited); everybody else is refused; an empty text clears it', async () => {
    expect(await setPlantPhone(app, owner, plantA, '+212 5 00 00 00 01')).toEqual({ ok: true, value: true });
    expect(await phoneOf(plantA)).toBe('+212 5 00 00 00 01');
    expect(await setPlantPhone(app, appAdmin, plantB, '0500000002')).toEqual({ ok: true, value: true });
    for (const u of [pmA, pmB, sales, purchases, accountant, driver1, pumpOp, partner, support]) {
      await expect(setPlantPhone(app, u, plantA, '0500000000'), u.role).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(
        await denied(
          asRole(u, (tx) => tx.query('select public.set_plant_phone($1, $2)', [plantA, '0500000000'])),
        ),
        u.role,
      ).toBe(true);
    }
    expect(await phoneOf(plantA)).toBe('+212 5 00 00 00 01');
    expect(await setPlantPhone(app, owner, plantA, 'appelez-moi')).toEqual({ ok: false, error: 'INVALID' });
    const audit = await superRows<{ actor_user_id: string; after: { phone?: string } }>(
      `select actor_user_id, after from audit_event where table_name = 'plant' and action = 'update' and row_id = $1 order by id desc limit 2`,
      [plantB],
    );
    expect(audit[0]).toMatchObject({ actor_user_id: appAdmin.id, after: { phone: '0500000002' } });
    expect(await setPlantPhone(app, owner, plantB, '')).toEqual({ ok: true, value: true });
    expect(await phoneOf(plantB)).toBeNull();
  });

  it('a driver reads the phone of the plant of his own rotations, and nothing else of any plant; none when unset', async () => {
    await setPlantPhone(app, owner, plantA, '0500000111');
    const a = await newTrip(plantA, truckA, driverRow1);
    const b = await newTrip(plantB, truckB, driverRow1); // plant B has no phone
    const other = await newTrip(plantA, truckA, driverRow2);
    const mine = await asRole(
      driver1,
      async (tx) =>
        (
          await tx.query<{ trip_id: string; phone: string }>('select * from public.driver_plant_phones($1)', [
            DAY,
          ])
        ).rows,
    );
    const ids = new Map(mine.map((r) => [r.trip_id, r.phone]));
    expect(ids.get(a)).toBe('0500000111');
    expect(ids.has(b)).toBe(false);
    expect(ids.has(other)).toBe(false);
    for (const u of [pmA, owner, sales])
      expect(
        await denied(asRole(u, (tx) => tx.query('select * from public.driver_plant_phones($1)', [DAY]))),
        u.role,
      ).toBe(true);
  });
});
