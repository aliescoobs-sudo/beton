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
import { v1Actors } from './helpers/v1-actors';

// T9 (docs/T9-TRIP-SHARED-STATUS.md): ONE shared status of a rotation, written by the driver and by the plant through record_trip_stage.
// Forward-only with an implicit fill, idempotent and race-safe, corrections as new rows, authorization in the database, and a driver's
// tap that changes no stock, delivery, delivered mark or invoice figure.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 14 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `ts${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const DAY = businessDateOf(realClock.now());
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
  const code = `CH-${5000 + Math.floor(Math.random() * 4000)}`;
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
): Promise<string> {
  return asOwner(plant, async (tx) => {
    const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY);
    const id = randomUUID();
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, $6, 4000, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        randomUUID(),
        DAY,
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

describe('T9: forward only, with an implicit fill', () => {
  it('a later stage fills the skipped ones as implicit rows with the same instant; nothing existing is rewritten', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const first = await record(driver1, trip, 'loading_started', { now: new Date(Date.now() - 60_000) });
    expect(first).toMatchObject({
      o_recorded: true,
      o_source: 'driver',
      o_actor_role: 'driver',
      o_implicit: false,
    });
    const later = await record(driver1, trip, 'arrived');
    expect(later).toMatchObject({ o_stage: 'arrived', o_recorded: true, o_implicit: false });
    const rows = await stored(trip);
    expect(rows.map((r) => [r.step, r.implicit])).toEqual([
      ['loading_started', false],
      ['loaded', true],
      ['departed', true],
      ['arrived', false],
    ]);
    // the filled rows carry the instant of the stage that caused them, no phone time, no key, no load
    const filled = rows.filter((r) => r.implicit);
    expect(new Set(filled.map((r) => r.at.getTime())).size).toBe(1);
    expect(filled[0]!.at.getTime()).toBe(rows[3]!.at.getTime());
    for (const r of filled)
      expect([r.client_time, r.client_key, r.delivery_id, r.source]).toEqual([null, null, null, 'driver']);
    // the first stage was not touched by the later one
    expect(rows[0]!.at.getTime()).toBe(first.o_at.getTime());
  });

  it('the latest row by (at, created_at) is the latest stage, filled-in rows included (readers that sort that way, such as the emergency options)', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(driver1, trip, 'arrived');
    const latest = await superRows<{ step: string }>(
      `select step from trip_event where trip_id = $1 order by at desc, created_at desc limit 1`,
      [trip],
    );
    expect(latest[0]?.step).toBe('arrived');
  });

  it('an earlier stage than the latest is already there: it is returned as it is, and its author and time stay', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const departed = await record(driver1, trip, 'departed');
    const again = await record(pmA, trip, 'loaded'); // the plant "records" a stage that was filled in
    expect(again).toMatchObject({
      o_stage: 'loaded',
      o_recorded: false,
      o_implicit: true,
      o_source: 'driver',
    });
    expect(again.o_at.getTime()).toBe(departed.o_at.getTime());
    expect((await stored(trip)).filter((r) => r.step === 'loaded')).toHaveLength(1);
  });

  it('the instant never goes back: a writer whose clock is behind records at the latest instant already stored', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const a = await record(driver1, trip, 'loading_started', { now: new Date() });
    const b = await record(pmA, trip, 'loaded', { now: new Date(Date.now() - 5 * 60_000) });
    expect(b.o_at.getTime()).toBeGreaterThanOrEqual(a.o_at.getTime());
  });

  it('an unknown stage is refused', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    expect(await denied(record(driver1, trip, 'teleported'), '23514')).toBe(true);
  });

  it('a cancelled rotation takes no stage', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await asOwner(plantA, (tx) =>
      tx.query(
        `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'replanned', $2)`,
        [trip, owner.id],
      ),
    );
    expect(await denied(record(driver1, trip, 'loading_started'), '23514')).toBe(true);
  });
});

describe('T9: idempotent and race-safe', () => {
  it('two taps on the same stage record one row; the second is told who recorded it and when', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const a = await record(driver1, trip, 'loading_started');
    const b = await record(pmA, trip, 'loading_started');
    expect(a.o_recorded).toBe(true);
    expect(b).toMatchObject({ o_recorded: false, o_source: 'driver', o_actor_role: 'driver' });
    expect(b.o_at.getTime()).toBe(a.o_at.getTime());
    expect((await stored(trip)).filter((r) => r.step === 'loading_started')).toHaveLength(1);
  });

  it("a replay with the same key is answered 'replayed' and changes nothing (offline queue)", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const key = `k-${randomUUID()}`;
    expect(await tap(driver1, trip, 'loading_started', new Date(), key)).toBe('recorded');
    expect(await tap(driver1, trip, 'loading_started', new Date(), key)).toBe('replayed');
    expect(await tap(driver1, trip, 'loading_started', new Date(), `k-${randomUUID()}`)).toBe('replayed'); // same stage, another key
    expect(await stepsOf(trip)).toEqual(['loading_started']);
  });

  it('parallel taps on one stage, from the driver, the plant manager and the owner: exactly one row, no error, one winner told to all', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const runs = await Promise.all([
      ...Array.from({ length: 6 }, () => record(driver1, trip, 'departed')),
      ...Array.from({ length: 3 }, () => record(pmA, trip, 'departed')),
      record(owner, trip, 'departed'),
    ]);
    expect(runs.filter((r) => r.o_recorded)).toHaveLength(1);
    const winner = runs.find((r) => r.o_recorded)!;
    for (const r of runs) {
      expect(r.o_at.getTime()).toBe(winner.o_at.getTime());
      expect(r.o_source).toBe(winner.o_source);
    }
    const rows = await stored(trip);
    expect(rows.map((r) => r.step).sort()).toEqual(['departed', 'loaded', 'loading_started']);
    expect(rows.filter((r) => r.step === 'departed')).toHaveLength(1);
  });

  it('parallel taps on different stages keep the order and fill each gap once', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await Promise.all([
      record(driver1, trip, 'arrived'),
      record(pmA, trip, 'departed'),
      record(driver1, trip, 'unloading_started'),
      record(pmA, trip, 'loading_started'),
      record(driver1, trip, 'loaded'),
    ]);
    expect(await stepsOf(trip)).toEqual([
      'loading_started',
      'loaded',
      'departed',
      'arrived',
      'unloading_started',
    ]);
    const rows = await stored(trip);
    for (const s of STAGES.slice(0, 5)) expect(rows.filter((r) => r.step === s)).toHaveLength(1);
    // times never decrease along the stages
    const byStage = new Map(rows.map((r) => [r.step, r.at.getTime()]));
    for (let i = 1; i < 5; i++)
      expect(byStage.get(STAGES[i]!)!).toBeGreaterThanOrEqual(byStage.get(STAGES[i - 1]!)!);
  });
});

describe("T9: authorization is the database's", () => {
  it('a driver records only his own rotation; another driver, a plant manager of another plant, and a plant-less rotation are refused alike', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const ghost = randomUUID();
    expect(await denied(record(driver2, trip, 'loading_started'))).toBe(true);
    expect(await denied(record(pmB, trip, 'loading_started'))).toBe(true);
    expect(await denied(record(driver1, ghost, 'loading_started'))).toBe(true); // unknown id: the same answer, no oracle
    expect(await stepsOf(trip)).toEqual([]);
    // a rotation that names no plant: a plant manager does not record it (the owner does)
    const free = await newTrip(plantA, truckN, driverRow1);
    await superRows(`update trip_plan set plant_id = null where id = $1`, [free], true);
    expect(await denied(record(pmA, free, 'loading_started'))).toBe(true);
    expect((await record(owner, free, 'loading_started')).o_source).toBe('admin');
  });

  it('partner, support, office, accountant and an unknown user have no way to record or correct a stage', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(driver1, trip, 'loading_started');
    for (const u of [partner, support, sales, accountant]) {
      expect(await denied(record(u, trip, 'loaded')), u.role).toBe(true);
      expect(
        await denied(
          asRole(u, (tx) =>
            tx.query('select public.correct_trip_stage($1, $2, $3, $4)', [
              trip,
              'loading_started',
              new Date(),
              'Erreur de saisie',
            ]),
          ),
        ),
        u.role,
      ).toBe(u.role !== 'office_sales'); // office_sales alone holds the narrow right to correct (T9b addendum); the correction itself is tested in trip-correct-permission
      expect(await denied(stagesFor(u)), u.role).toBe(true);
    }
    const stranger = { ...owner, id: randomUUID(), role: 'plant_manager' } as unknown as SessionUser; // a user the database does not know
    expect(await denied(record(stranger, trip, 'loaded'))).toBe(true);
    expect(await stepsOf(trip)).toEqual(['loading_started']);
  });

  it("the application's own login cannot write the table directly: a plant manager insert is refused; update and delete are refused to everyone", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const direct = (u: SessionUser) =>
      asRole(u, (tx) =>
        tx.query(
          `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'loading_started', now(), $2)`,
          [trip, u.id],
        ),
      );
    expect(await denied(direct(pmA))).toBe(true);
    expect(await denied(direct(driver1))).toBe(true);
    await record(driver1, trip, 'loading_started');
    expect(
      await denied(
        asOwner(plantA, (tx) => tx.query(`update trip_event set at = now() where trip_id = $1`, [trip])),
      ),
    ).toBe(true);
    expect(
      await denied(asOwner(plantA, (tx) => tx.query(`delete from trip_event where trip_id = $1`, [trip]))),
    ).toBe(true);
    // not even the database owner may change a stage: the only update the table allows is a load linked once to a loaded stage
    await expect(superRows(`update trip_event set at = now() where trip_id = $1`, [trip])).rejects.toThrow(
      /insert-only/,
    );
    await expect(
      superRows(`update trip_event set source = 'plant' where trip_id = $1`, [trip]),
    ).rejects.toThrow(/insert-only/);
  });

  it("a plant manager sees only his plant's stages, a driver only his own, the owner and app_admin all", async () => {
    const a = await newTrip(plantA, truckA, driverRow1, 430);
    const b = await newTrip(plantB, truckB, driverRow2, 440);
    await record(driver1, a, 'loading_started');
    await record(driver2, b, 'loading_started');
    const ids = (rows: { trip_id: string }[]) => new Set(rows.map((r) => r.trip_id));
    expect(ids(await stagesFor(pmA))).toContain(a);
    expect(ids(await stagesFor(pmA))).not.toContain(b);
    expect(ids(await stagesFor(pmB))).toContain(b);
    expect(ids(await stagesFor(pmB))).not.toContain(a);
    expect(ids(await stagesFor(driver1))).toContain(a);
    expect(ids(await stagesFor(driver1))).not.toContain(b);
    for (const u of [owner, appAdmin]) {
      const seen = ids(await stagesFor(u));
      expect(seen.has(a) && seen.has(b)).toBe(true);
    }
    // and the raw table, read directly, is scoped the same way
    const raw = (u: SessionUser) =>
      asRole(
        u,
        async (tx) =>
          new Set(
            (
              await tx.query<{ trip_id: string }>('select trip_id from trip_event where trip_id = any($1)', [
                [a, b],
              ])
            ).rows.map((r) => r.trip_id),
          ),
      );
    expect(await raw(pmA)).toEqual(new Set([a]));
    expect(await raw(pmB)).toEqual(new Set([b]));
  });
});

describe("T9: the phone's time and the server's", () => {
  it("an offline tap keeps the phone's time apart; the stage is stamped with the server's instant; the delay figure uses the phone's", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const phone = new Date(Date.now() - 20 * 60_000);
    const out = await asRole(
      driver1,
      async (tx) =>
        (
          await tx.query<Out>('select * from public.record_trip_stage($1, $2, $3, $4, $5)', [
            trip,
            'loading_started',
            new Date(),
            phone,
            `k-${randomUUID()}`,
          ])
        ).rows[0]!,
    );
    expect(out.o_at.getTime()).toBeGreaterThan(phone.getTime() + 19 * 60_000);
    const row = (await stored(trip))[0]!;
    expect(row.client_time?.getTime()).toBe(phone.getTime());
    const delay = await superRows<{ tapped_at: Date }>(
      `select tapped_at from trip_delay where trip_id = $1 and step = 'loading_started'`,
      [trip],
    );
    expect(delay[0]?.tapped_at.getTime()).toBe(phone.getTime());
  });

  it('a phone time from the future or from long ago is refused; a plant has no phone time', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    expect(
      await denied(
        record(driver1, trip, 'loading_started', { client: new Date(Date.now() + 3600_000) }),
        '23514',
      ),
    ).toBe(true);
    expect(
      await denied(
        record(driver1, trip, 'loading_started', { client: new Date(Date.now() - 72 * 3600_000) }),
        '23514',
      ),
    ).toBe(true);
    expect(await denied(record(pmA, trip, 'loading_started', { client: new Date() }), '23514')).toBe(true);
  });

  it("the plant's stage for a driver counts in the delay figures like his own tap", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(pmA, trip, 'departed'); // loading_started and loaded filled in; departed is explicit
    const steps = (
      await superRows<{ step: string }>(`select step from trip_delay where trip_id = $1 order by step`, [
        trip,
      ])
    ).map((r) => r.step);
    expect(steps).toEqual(['departed']); // a filled-in stage measures nothing
  });
});

describe('T9: corrections are new rows, by the plant manager of the plant, the owner or app_admin, with a reason', () => {
  it("a correction supersedes the time in both screens' read; the stage row is untouched; the chain of corrections is kept", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const t0 = new Date(Date.now() - 30 * 60_000);
    await record(driver1, trip, 'loading_started', { now: t0 });
    await record(pmA, trip, 'loaded', { now: new Date(t0.getTime() + 5 * 60_000) });
    const dep = await record(driver1, trip, 'departed', { now: new Date(t0.getTime() + 10 * 60_000) });
    const fix1 = new Date(t0.getTime() + 8 * 60_000);
    const fix2 = new Date(t0.getTime() + 9 * 60_000);
    const correct = (u: SessionUser, when: Date, reason: string) =>
      asRole(u, (tx) =>
        tx.query('select public.correct_trip_stage($1, $2, $3, $4)', [trip, 'departed', when, reason]),
      );
    await correct(pmA, fix1, 'Départ saisi en retard');
    await correct(owner, fix2, 'Heure du portail relue');
    const view = (await stagesFor(pmA)).find((r) => r.trip_id === trip && r.step === 'departed')!;
    expect(view.corrected_at?.getTime()).toBe(fix2.getTime());
    expect(view.at.getTime()).toBe(dep.o_at.getTime()); // the recorded instant is still reported as it was
    const rows = await superRows<{
      corrected_at: Date;
      previous_at: Date;
      reason: string;
      actor_role: string;
      actor_id: string;
    }>(
      `select corrected_at, previous_at, reason, actor_role, actor_id from trip_event_correction where trip_id = $1 order by created_at`,
      [trip],
    );
    expect(rows.map((r) => r.actor_role)).toEqual(['plant_manager', 'owner']);
    expect(rows[0]!.previous_at.getTime()).toBe(dep.o_at.getTime());
    expect(rows[1]!.previous_at.getTime()).toBe(fix1.getTime());
    expect(rows.map((r) => r.reason)).toEqual(['Départ saisi en retard', 'Heure du portail relue']);
    const original = (await stored(trip)).find((r) => r.step === 'departed')!;
    expect(original.at.getTime()).toBe(dep.o_at.getTime());
  });

  it('refused: no reason, a padded or short reason, a time that breaks the order, an unrecorded stage, the driver, another plant, any other role', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const t0 = new Date(Date.now() - 30 * 60_000);
    await record(driver1, trip, 'loading_started', { now: t0 });
    await record(pmA, trip, 'loaded', { now: new Date(t0.getTime() + 5 * 60_000) });
    await record(driver1, trip, 'departed', { now: new Date(t0.getTime() + 10 * 60_000) });
    const c = (u: SessionUser, stage: string, when: Date, reason: string | null) =>
      asRole(u, (tx) =>
        tx.query('select public.correct_trip_stage($1, $2, $3, $4)', [trip, stage, when, reason]),
      );
    const ok = new Date(t0.getTime() + 5 * 60_000);
    for (const bad of [null, '', 'ab', ' marge ', 'x'.repeat(501)])
      expect(await denied(c(pmA, 'departed', ok, bad), '23514'), String(bad)).toBe(true);
    expect(await denied(c(pmA, 'departed', new Date(t0.getTime() - 60_000), 'Avant le début'), '23514')).toBe(
      true,
    ); // before the previous stage
    expect(
      await denied(
        c(pmA, 'loading_started', new Date(t0.getTime() + 11 * 60_000), 'Après le départ'),
        '23514',
      ),
    ).toBe(true); // after the next stage
    expect(await denied(c(pmA, 'back', ok, 'Pas encore enregistrée'), '23514')).toBe(true);
    expect(await denied(c(pmA, 'departed', new Date(Date.now() + 3600_000), 'Dans le futur'), '23514')).toBe(
      true,
    );
    expect(await denied(c(driver1, 'departed', ok, 'Je corrige moi-même'))).toBe(true);
    expect(await denied(c(pmB, 'departed', ok, 'Autre centrale'))).toBe(true);
    for (const u of [partner, support, accountant])
      expect(await denied(c(u, 'departed', ok, 'Pas mon rôle')), u.role).toBe(true);
    expect(await superRows(`select 1 from trip_event_correction where trip_id = $1`, [trip])).toHaveLength(0);
    // and a correction row can neither be changed nor deleted
    await c(pmA, 'departed', ok, 'Correction valable');
    await expect(
      superRows(`update trip_event_correction set reason = 'autre' where trip_id = $1`, [trip]),
    ).rejects.toThrow(/append-only/);
    await expect(superRows(`delete from trip_event_correction where trip_id = $1`, [trip])).rejects.toThrow(
      /append-only/,
    );
  });

  it('the audit log records who recorded each stage and, for a correction, the actor and the reason', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(driver1, trip, 'loading_started');
    await record(pmA, trip, 'loaded');
    await asRole(pmA, (tx) =>
      tx.query('select public.correct_trip_stage($1, $2, $3, $4)', [
        trip,
        'loaded',
        new Date(),
        'Chargement relu au bon de pesée',
      ]),
    );
    const events = await superRows<{
      actor_user_id: string;
      action: string;
      table_name: string;
      reason: string | null;
      hash: Buffer | null;
      prev_hash: Buffer | null;
      after: { actor_role?: string; source?: string; step?: string } | null;
    }>(
      `select a.actor_user_id, a.action, a.table_name, a.reason, a.hash, a.prev_hash, a.after
         from audit_event a
        where (a.table_name = 'trip_event' and a.row_id in (select id::text from trip_event where trip_id = $1))
           or (a.table_name = 'trip_event_correction' and a.after->>'trip_id' = $1::text)
        order by a.id`,
      [trip],
    );
    const inserts = events.filter((e) => e.table_name === 'trip_event' && e.action === 'insert');
    expect(
      inserts.map((e) => [e.after?.step, e.actor_user_id, e.after?.source, e.after?.actor_role]),
    ).toEqual([
      ['loading_started', driver1.id, 'driver', 'driver'],
      ['loaded', pmA.id, 'plant', 'plant_manager'],
    ]);
    const reversal = events.find((e) => e.action === 'reverse');
    expect(reversal).toMatchObject({ actor_user_id: pmA.id, reason: 'Chargement relu au bon de pesée' });
    expect(
      events.find((e) => e.table_name === 'trip_event_correction' && e.action === 'insert')?.actor_user_id,
    ).toBe(pmA.id);
    for (const e of events) expect(e.hash).not.toBeNull();
  });
});

describe('T9: money and stock separation', () => {
  /** What a driver's tap must not touch, for this rotation's order: the load, its stock, its delivered mark, its invoice lines. */
  async function figures(orderId: string) {
    const q = async (sql: string) => Number((await superRows<{ n: string }>(sql, [orderId]))[0]!.n);
    return {
      deliveries: await q(`select count(*) n from delivery where order_id = $1`),
      litres: await q(`select coalesce(sum(volume_l), 0) n from delivery where order_id = $1`),
      stock: await q(
        `select count(*) n from stock_movement where source = 'delivery' and source_id in (select id from delivery where order_id = $1)`,
      ),
      stockQty: await q(
        `select coalesce(sum(qty_base), 0) n from stock_movement where source = 'delivery' and source_id in (select id from delivery where order_id = $1)`,
      ),
      delivered: await q(
        `select count(*) n from delivery_delivered where delivery_id in (select id from delivery where order_id = $1)`,
      ),
      invoiced: await q(
        `select count(*) n from invoice_line where delivery_id in (select id from delivery where order_id = $1)`,
      ),
      orderTotal: await q(`select total_ttc_centimes n from sales_order where id = $1`),
    };
  }

  it('every stage a driver can tap, loaded and unloading finished included, changes no delivery, stock, delivered mark or invoice figure', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    // the plant has its own load of the order in the books (BL and stock): a driver's tap must leave it exactly as it is
    const load = await plantLoad(plantA, trip, truckA);
    const orderId = await orderOf(trip);
    const before = await figures(orderId);
    expect(before.deliveries).toBe(1);
    for (const step of STAGES)
      await tap(
        driver1,
        trip,
        step,
        new Date(),
        `k-${randomUUID()}`,
        step === 'unloading_finished' ? 4000 : null,
      );
    expect(await figures(orderId)).toEqual(before);
    expect(await stepsOf(trip)).toEqual([...STAGES]);
    // the declared loaded stage has no load linked: nothing of the plant's load was attached by the driver
    expect((await stored(trip)).find((r) => r.step === 'loaded')!.delivery_id).toBeNull();
    expect(load).toBeTruthy();
  });

  it('a driver cannot link a load, record a load stage with a load, or reach the delivered mark', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const load = await plantLoad(plantA, trip, truckA);
    expect(await denied(record(driver1, trip, 'loaded', { delivery: load }))).toBe(true);
    await record(driver1, trip, 'loaded');
    expect(
      await denied(asRole(driver1, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load]))),
    ).toBe(true);
    expect(
      await denied(asRole(driver1, (tx) => tx.query('select public.confirm_trip_delivered($1)', [trip]))),
    ).toBe(true);
  });

  it('the plant links its own load once to the stage the driver declared; the stage keeps its author and time', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    const declared = await record(driver1, trip, 'loaded');
    const load = await plantLoad(plantA, trip, truckA);
    await asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load]));
    const row = (await stored(trip)).find((r) => r.step === 'loaded')!;
    expect(row.delivery_id).toBe(load);
    expect(row.source).toBe('driver'); // who declared it is not rewritten
    expect(row.at.getTime()).toBe(declared.o_at.getTime());
    expect(
      await denied(
        asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load])),
        '23514',
      ),
    ).toBe(true); // once
    expect(
      await denied(asRole(pmB, (tx) => tx.query('select public.attach_trip_load($1, $2)', [trip, load]))),
    ).toBe(true);
    const stages = (await stagesFor(pmA)).find((r) => r.trip_id === trip && r.step === 'loaded')!;
    expect(stages.load_linked).toBe(true);
    // a load of another rotation's order cannot be linked
    const other = await newTrip(plantA, truckA, driverRow1, 500);
    await record(driver1, other, 'loaded');
    expect(
      await denied(
        asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [other, load])),
        '42501', // R18-07: refused by the door itself (one answer), before the stage trigger that used to say 23514
      ),
    ).toBe(true);
  });

  it("a delivered mark follows only the plant's own explicit unloading stage; a driver's or a filled-in one waits for the plant's confirmation", async () => {
    const delivered = async (load: string) =>
      (await superRows(`select 1 from delivery_delivered where delivery_id = $1`, [load])).length;
    // (a) the driver declares the end of the unloading: the plant's load stays undelivered until the plant confirms, once
    const a = await newTrip(plantA, truckA, driverRow1);
    const loadA = await plantLoad(plantA, a, truckA);
    await record(driver1, a, 'loaded');
    await asRole(pmA, (tx) => tx.query('select public.attach_trip_load($1, $2)', [a, loadA]));
    await tap(driver1, a, 'unloading_finished', new Date(), `k-${randomUUID()}`, 4000);
    expect(await delivered(loadA)).toBe(0);
    expect(
      await asRole(
        pmA,
        async (tx) =>
          (await tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [a])).rows[0]!.c,
      ),
    ).toBe(true);
    expect(await delivered(loadA)).toBe(1);
    expect(
      await asRole(
        pmA,
        async (tx) =>
          (await tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [a])).rows[0]!.c,
      ),
    ).toBe(false); // idempotent
    expect(await delivered(loadA)).toBe(1);
    // (b) the plant records the end of the unloading itself: delivered at once, as before
    const b = await newTrip(plantA, truckA, driverRow1, 460);
    const loadB = await plantLoad(plantA, b, truckA);
    await record(pmA, b, 'loaded', { delivery: loadB });
    await record(pmA, b, 'unloading_finished');
    expect(await delivered(loadB)).toBe(1);
    // (c) the plant skips to "back": the unloading stage is filled in, and a filled-in stage delivers nothing
    const c = await newTrip(plantA, truckA, driverRow1, 470);
    const loadC = await plantLoad(plantA, c, truckA);
    await record(pmA, c, 'loaded', { delivery: loadC });
    await record(pmA, c, 'back');
    expect(await delivered(loadC)).toBe(0);
    // (d) confirming needs the plant's load and a finished unloading
    const d = await newTrip(plantA, truckA, driverRow1, 480);
    await tap(driver1, d, 'unloading_finished', new Date(), `k-${randomUUID()}`, 4000);
    expect(
      await denied(
        asRole(pmA, (tx) => tx.query('select public.confirm_trip_delivered($1)', [d])),
        '23514',
      ),
    ).toBe(true);
    expect(await denied(asRole(pmB, (tx) => tx.query('select public.confirm_trip_delivered($1)', [a])))).toBe(
      true,
    );
  });

  it("the driver's declared m3 is a declared figure: it is kept apart from every delivered quantity", async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await tap(driver1, trip, 'unloading_finished', new Date(), `k-${randomUUID()}`, 3500);
    const rep = await superRows<{ volume_l: number }>(
      `select volume_l from trip_driver_report where trip_id = $1 and kind = 'unloaded'`,
      [trip],
    );
    expect(rep.map((r) => r.volume_l)).toEqual([3500]);
    expect(await superRows(`select 1 from delivery where order_id = $1`, [await orderOf(trip)])).toHaveLength(
      0,
    );
    // the m3 is required with the stage the driver taps himself, and a refusal records nothing
    const t2 = await newTrip(plantA, truckA, driverRow1, 500);
    expect(await denied(tap(driver1, t2, 'unloading_finished'), '23514')).toBe(true);
    expect(await stepsOf(t2)).toEqual([]);
  });
});

describe('T9: what the legacy readers still see', () => {
  it('"loading began" reaches the timing read model once, and the rotation counts as started', async () => {
    const trip = await newTrip(plantA, truckA, driverRow1);
    await record(driver1, trip, 'loading_started');
    const timing = await asRole(
      pmA,
      async (tx) =>
        (
          await tx.query<{ trip_id: string; steps: { step: string }[] }>(
            'select trip_id, steps from public.trip_timing($1)',
            [DAY],
          )
        ).rows,
    );
    const mine = timing.find((r) => r.trip_id === trip)!;
    expect(mine.steps.filter((s) => s.step === 'loading_started')).toHaveLength(1);
    const started = await asRole(
      pmA,
      async (tx) =>
        (await tx.query<{ s: boolean }>('select public.trip_started($1) as s', [trip])).rows[0]!.s,
    );
    expect(started).toBe(true);
  });
});
