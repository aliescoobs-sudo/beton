import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { businessDateOf, realClock } from '../src/modules/clock';
import { createPlant, createTruck, updatePlant } from '../src/modules/master-data';
import {
  getDelayStats,
  getTimingBoard,
  localMidnightMs,
  postponeTrip,
  reassignTrip,
  setTripEstimate,
  setTruckDefaultDriver,
} from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  type DeliveryScene,
} from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// T5 phase 2: the delay of every driver tap is recorded, the board and the statistics are scoped in the database (the driver's own, his
// plant manager's plant, owner and app_admin), estimates fall back from history to an audited override, and a plant manager can reassign or
// postpone a rotation that has not started. Rotations are on YESTERDAY so the taps are inside the door's 48 hours whatever the hour.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `tt${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const DAY = addDays(businessDateOf(realClock.now()), -1);
const AT = (min: number) => new Date(localMidnightMs(DAY) + min * 60_000);
const NOW_MS = localMidnightMs(DAY) + 8 * 3600_000 + 30 * 60_000; // 08:30 yesterday, for the board

let done: () => Promise<void>;
let owner: SessionUser,
  pmA: SessionUser,
  pmB: SessionUser,
  accountant: SessionUser,
  sales: SessionUser,
  purchases: SessionUser;
let partner: SessionUser, support: SessionUser, appAdmin: SessionUser;
let driver1: SessionUser, driver2: SessionUser;
let plantA = '',
  plantB = '';
let scene: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
let truck2 = '';
let truckB = '';
let driverRow1 = '',
  driverRow2 = '';
let tripA1 = '',
  tripA2 = '',
  tripB1 = '';

const asOwner = <T>(plant: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plant]);
    return fn(tx);
  });
const asRole = <T>(u: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);

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
  const code = `CH-${7000 + Math.floor(Math.random() * 2000)}`;
  const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
  await c.connect();
  try {
    await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
      SYSTEM_ACTOR_ID,
    ]);
    return (
      await c.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, kind, user_id) values (gen_random_uuid(), $1, $2, $3, 'driver', $4) returning id`,
        [code, name, owner.id, user.id],
      )
    ).rows[0]!.id;
  } finally {
    await c.end();
  }
}
/** A statement as the database owner with the row guards off: the rotation's plant-side steps are not what is under test here. */
async function sudo(sql: string, params: unknown[] = []): Promise<void> {
  const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
  await c.connect();
  try {
    await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
      SYSTEM_ACTOR_ID,
    ]);
    await c.query('set session_replication_role = replica');
    await c.query(sql, params);
  } finally {
    await c.end();
  }
}
/** The plant loads the rotation (a delivery of its order on its truck, and the `loaded` step), as the plant's own tracking does. */
const plantLoads = (trip: string, at: Date, plant: string, orderId: string, truckId: string) =>
  asOwner(plant, async (tx) => {
    const d = await insertDelivery(tx, owner.id, { orderId, truckId, recetteId: scene.recetteId }, 1000);
    const id = (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo])).rows[0]!
      .id;
    await tx.query(
      `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', $2, $3, $4)`,
      [trip, at, id, owner.id],
    );
  });
const orderOfTrip = async (trip: string) =>
  (await migrator.query<{ order_id: string }>(`select order_id from trip_plan where id = $1`, [trip]))
    .rows[0]!.order_id;
async function newTrip(
  plant: string,
  truckId: string,
  driverId: string | null,
  loadMin: number,
  seq = 1,
  existingOrder?: string,
  tripDate = DAY,
): Promise<string> {
  return asOwner(plant, async (tx) => {
    const o = existingOrder
      ? { id: existingOrder }
      : await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY);
    const id = randomUUID();
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 8000, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        randomUUID(),
        tripDate,
        o.id,
        seq,
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
const tap = (
  u: SessionUser,
  trip: string,
  step: string,
  at: Date,
  key: string,
  vol: number | null = null,
  reason: string | null = null,
) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, (tx) =>
    tx.query<{ r: string }>('select public.driver_report($1, $2, $3, $4, $5, $6) as r', [
      trip,
      step,
      at,
      key,
      vol,
      reason,
    ]),
  );
const refused = async (p: Promise<unknown>) => {
  try {
    const r = (await p) as { ok?: boolean } | null;
    return r === null || r?.ok === false;
  } catch {
    return true;
  }
};

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantA = v.plantId;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  accountant = v.session('accountant') as unknown as SessionUser;
  sales = v.session('office_sales') as unknown as SessionUser;
  purchases = v.session('office_purchases') as unknown as SessionUser;
  partner = v.session('partner') as unknown as SessionUser;
  support = v.session('support') as unknown as SessionUser;
  appAdmin = v.session('app_admin') as unknown as SessionUser;
  master = await orderMaster(app, owner.id, `${marker}a`);
  scene = await deliveryScene(app, owner.id, `${marker}a`, DAY);
  const b = await createPlant(app, owner, { code: letters(6), name: `TTB ${marker}` });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  pmB = await userRow('plant_manager', plantB);
  driver1 = await userRow('driver', null);
  driver2 = await userRow('driver', null);
  driverRow1 = await newDriver(`Chauffeur un ${marker}`, driver1);
  driverRow2 = await newDriver(`Chauffeur deux ${marker}`, driver2);
  // a second truck at plant A, a truck at plant B
  const mk = async (plant: string, tag: string) => {
    for (let i = 0; i < 30; i++) {
      const r = await createTruck(app, owner, {
        code: `T${100 + Math.floor(Math.random() * 890)}`,
        plate: `TT-${marker.slice(0, 8)}-${tag}${i}`,
        plantId: plant,
      });
      if (r.ok) return r.value.id;
    }
    throw new Error('no truck code');
  };
  truck2 = await mk(plantA, 'a');
  truckB = await mk(plantB, 'b');
  tripA1 = await newTrip(plantA, scene.truckId, driverRow1, 420, 1, scene.orderId);
  tripA2 = await newTrip(plantA, scene.truckId, driverRow1, 530, 1); // the same truck's next rotation, planned from 08:50
  tripB1 = await newTrip(plantB, truckB, driverRow2, 420, 1);
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('every driver tap records its delay', () => {
  it('stores the planned time, the phone time, the server time, the stage delay, the cumulative delay and the reason; a replay changes nothing', async () => {
    await plantLoads(tripA1, AT(428), plantA, scene.orderId, scene.truckId);
    const t1 = await tap(driver1, tripA1, 'loading_started', AT(425), `k-${marker}-1`);
    expect(t1.rows[0]?.r).toBe('recorded');
    await tap(driver1, tripA1, 'departed', AT(450), `k-${marker}-2`, null, 'traffic'); // 20 min after the plan (07:10 -> 07:30)
    await tap(driver1, tripA1, 'departed', AT(450), `k-${marker}-2`, null, 'traffic'); // the same tap again
    const rows = (
      await migrator.query<{
        step: string;
        cumulative_delay_min: number;
        stage_delay_min: number | null;
        reason: string | null;
        planned_at: Date;
        tapped_at: Date;
        received_at: Date;
      }>(
        `select step, cumulative_delay_min, stage_delay_min, reason, planned_at, tapped_at, received_at from trip_delay where trip_id = $1 order by tapped_at`,
        [tripA1],
      )
    ).rows;
    expect(rows.map((r) => r.step)).toEqual(['loading_started', 'departed']);
    expect(rows[0]).toMatchObject({ cumulative_delay_min: 5, stage_delay_min: null });
    // departed: 25-minute loading stage against 10 planned... the tap at 450 against the plan's 430 is +20; the stage (425 -> 450 = 25) against 10 is +15
    expect(rows[1]).toMatchObject({ cumulative_delay_min: 20, stage_delay_min: 15, reason: 'traffic' });
    expect(rows[1]!.planned_at.getTime()).toBe(AT(430).getTime());
    expect(rows[1]!.tapped_at.getTime()).toBe(AT(450).getTime());
    expect(rows[1]!.received_at.getTime()).toBeGreaterThan(rows[1]!.tapped_at.getTime()); // the server's time is its own
  });
  it('an early tap is a negative delay; an unknown reason is refused; a stage tapped without the one before has no stage delay', async () => {
    await plantLoads(tripB1, AT(425), plantB, await orderOfTrip(tripB1), truckB);
    await tap(driver2, tripB1, 'departed', AT(430), `k-${marker}-3a`); // on time; loading_started was never tapped: no stage delay
    await tap(driver2, tripB1, 'arrived', AT(455), `k-${marker}-3`); // planned 07:40 (460): 5 minutes early
    const rows = (
      await migrator.query<{ step: string; cumulative_delay_min: number; stage_delay_min: number | null }>(
        `select step, cumulative_delay_min, stage_delay_min from trip_delay where trip_id = $1 order by tapped_at`,
        [tripB1],
      )
    ).rows;
    expect(rows[0]).toMatchObject({ step: 'departed', cumulative_delay_min: 0, stage_delay_min: null });
    expect(rows[1]).toMatchObject({ step: 'arrived', cumulative_delay_min: -5, stage_delay_min: -5 }); // 25 minutes against 30 planned
    await expect(
      tap(driver2, tripB1, 'unloading_started', AT(465), `k-${marker}-4`, null, 'laziness'),
    ).rejects.toThrow(/unknown delay reason/);
  });
  it('the rows are append-only', async () => {
    await expect(
      migrator.query(`update trip_delay set cumulative_delay_min = 0 where trip_id = $1`, [tripA1]),
    ).rejects.toThrow(/append-only/);
    await expect(migrator.query(`delete from trip_delay where trip_id = $1`, [tripA1])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('who can read the delays (enforced by row-level security)', () => {
  const countAs = async (u: SessionUser) =>
    Number(
      (
        await asRole(u, (tx) =>
          tx.query<{ n: string }>(`select count(*)::text as n from trip_delay where trip_id in ($1, $2)`, [
            tripA1,
            tripB1,
          ]),
        )
      ).rows[0]!.n,
    );
  it('the owner and app_admin read both plants, a plant manager his plant, a driver his own', async () => {
    expect(await countAs(owner)).toBe(4);
    expect(await countAs(appAdmin)).toBe(4);
    expect(await countAs(pmA)).toBe(2); // plant A: the two taps of trip A1
    expect(await countAs(pmB)).toBe(2); // plant B: the two taps of trip B1
    expect(await countAs(driver1)).toBe(2);
    expect(await countAs(driver2)).toBe(2);
  });
  it('accountant, sales, purchases, partner and support read none of it', async () => {
    for (const u of [accountant, sales, purchases, partner, support])
      expect(await countAs(u), u.role).toBe(0);
  });
  it('the audit trail is no side door: its rows about the delays are read by the owner and app_admin only', async () => {
    const n = async (u: SessionUser) =>
      Number(
        (
          await asRole(u, (tx) =>
            tx.query<{ n: string }>(
              `select count(*)::text as n from audit_event where table_name in ('trip_delay', 'trip_dispatch_change', 'trip_estimate_override')`,
            ),
          )
        ).rows[0]!.n,
      );
    expect(await n(owner)).toBeGreaterThan(0);
    expect(await n(appAdmin)).toBeGreaterThan(0);
    for (const u of [partner, support, accountant, sales, purchases, pmA, pmB, driver1])
      expect(await n(u), u.role).toBe(0);
  });
  it('the timing door refuses those roles outright', async () => {
    for (const u of [accountant, sales, purchases, partner, support])
      await expect(getTimingBoard(app, u, DAY, NOW_MS), u.role).rejects.toThrow(/may not read the timing/);
  });
  it('the board shows a driver his own rotations, a plant manager his plant, the owner everything', async () => {
    const codes = async (u: SessionUser) =>
      (await getTimingBoard(app, u, DAY, NOW_MS)).trucks
        .flatMap((t) => t.trips.map((x) => x.trip.tripId))
        .sort();
    expect(await codes(driver1)).toEqual([tripA1, tripA2].sort());
    expect(await codes(driver2)).toEqual([tripB1]);
    expect(await codes(pmA)).toEqual([tripA1, tripA2].sort());
    expect(await codes(pmB)).toEqual([tripB1]);
    expect(await codes(owner)).toEqual(expect.arrayContaining([tripA1, tripA2, tripB1]));
  });
  it('the statistics are read under the same scoping', async () => {
    const taps = async (u: SessionUser) =>
      (await getDelayStats(app, u, DAY, DAY)).byStep.reduce((n, s) => n + s.taps, 0);
    expect(await taps(pmB)).toBe(2);
    expect(await taps(driver1)).toBe(2);
    expect(await taps(accountant)).toBe(0);
    const o = await getDelayStats(app, owner, DAY, DAY);
    expect(o.byDriver.map((d) => d.driverName)).toEqual(
      expect.arrayContaining([`Chauffeur un ${marker}`, `Chauffeur deux ${marker}`]),
    );
    expect(o.byDay[0]?.day).toBe(DAY);
  });
});

describe('the board projects from the last tap and flags the next rotation', () => {
  it('critical with the minutes and the next order named', async () => {
    const board = await getTimingBoard(app, pmA, DAY, NOW_MS);
    const truck = board.trucks.find((t) => t.truckId === scene.truckId)!;
    // departed 07:30 (planned 07:10): defaults to-site 30 (zone default), waiting 0, unloading, return; slip depends on the parameters in force
    expect(truck.trips[0]!.cumulativeDelayMin).toBe(20);
    expect(truck.status).toBe('en_route');
    expect(['critical', 'watch', 'none']).toContain(truck.alert.level);
    if (truck.alert.level === 'critical') {
      expect(truck.alert.slipMin).toBeGreaterThan(0);
      expect(truck.alert.nextTripId).toBe(tripA2);
    }
    const sources = Object.values(board.estimates).flatMap((e) => Object.values(e).map((v) => v.source));
    expect(sources.length).toBeGreaterThan(0);
  });
});

describe('estimates: history, then an audited override, then the defaults', () => {
  it('a plant manager overrides his own plant; another plant, the accountant and a bad figure are refused', async () => {
    const ok = await setTripEstimate(app, pmA, {
      plantId: plantA,
      zoneId: null,
      stage: 'to_site',
      minutes: 45,
      reason: 'Travaux sur la route',
    });
    expect(ok.ok).toBe(true);
    expect(
      await refused(
        setTripEstimate(app, pmA, {
          plantId: plantB,
          zoneId: null,
          stage: 'to_site',
          minutes: 45,
          reason: 'Autre centrale',
        }),
      ),
    ).toBe(true);
    expect(
      await refused(
        setTripEstimate(app, accountant, {
          plantId: plantA,
          zoneId: null,
          stage: 'to_site',
          minutes: 45,
          reason: 'Non',
        }),
      ),
    ).toBe(true);
    expect(
      await refused(
        setTripEstimate(app, pmA, {
          plantId: plantA,
          zoneId: null,
          stage: 'to_site',
          minutes: 9999,
          reason: 'Trop long',
        }),
      ),
    ).toBe(true);
    expect(
      (
        await setTripEstimate(app, owner, {
          plantId: plantB,
          zoneId: null,
          stage: 'unloading',
          minutes: 50,
          reason: 'Pompe lente',
        })
      ).ok,
    ).toBe(true);
    // audited, with its reason, as the person
    const audit = await migrator.query(
      `select 1 from audit_event where table_name = 'trip_estimate_override' and action = 'insert' and actor_user_id = $1`,
      [pmA.id],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });
  it('the board then uses the override, labelled as such', async () => {
    const board = await getTimingBoard(app, pmA, DAY, NOW_MS);
    const est = Object.entries(board.estimates).find(([k]) => k.startsWith(plantA))![1];
    expect(est.to_site).toEqual({ minutes: 45, source: 'override' });
  });
  it('with at least five completed rotations of the key, the median of the last ten wins over the override', async () => {
    const durations = [20, 22, 24, 26, 40]; // median 24
    for (const [i, d] of durations.entries()) {
      const id = await asOwner(plantA, async (tx) => {
        const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY);
        const t = randomUUID();
        await tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
           values ($1, $2, $3, $4, 1, $5, $6, 8000, 300, 310, 340, 380, 410, $7)`,
          [t, randomUUID(), addDays(DAY, -3 - i), o.id, truck2, driverRow1, owner.id],
        );
        return { t, o: o.id };
      });
      const base = new Date(localMidnightMs(addDays(DAY, -3 - i)) + 6 * 3600_000);
      const ev = (step: string, plus: number) =>
        sudo(
          `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`,
          [id.t, step, new Date(base.getTime() + plus * 60_000), SYSTEM_ACTOR_ID],
        );
      await ev('departed', 0);
      await ev('arrived', d);
      await ev('unloading_started', d + 5);
      await ev('unloading_finished', d + 35);
      await ev('back', d + 65);
    }
    const hist = await asRole(pmA, (tx) =>
      tx.query<{ minutes: number; source: string }>(
        `select * from public.trip_stage_estimate($1, null, 'to_site')`,
        [plantA],
      ),
    );
    expect(hist.rows[0]).toMatchObject({ source: 'history', minutes: 24 });
  });
});

describe('the plant manager can reassign or postpone a rotation that has not started, with a reason, audited', () => {
  it('reassigns the next rotation to another truck: a new rotation, the old one cancelled, the change recorded', async () => {
    const r = await reassignTrip(
      app,
      pmA,
      { tripId: tripA2, truckId: truck2, driverId: null, reason: 'Le camion T1 revient trop tard' },
      { today: DAY },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const live = await migrator.query(`select 1 from trip_plan where id = $1 and truck_id = $2`, [
      r.value.newTripId,
      truck2,
    ]);
    expect(live.rowCount).toBe(1);
    expect(
      (await migrator.query(`select 1 from trip_plan_cancellation where trip_id = $1`, [tripA2])).rowCount,
    ).toBe(1);
    const log = await migrator.query<{ kind: string; reason: string; to_truck: string }>(
      `select kind, reason, to_truck from trip_dispatch_change where old_trip_id = $1`,
      [tripA2],
    );
    expect(log.rows[0]).toMatchObject({
      kind: 'reassign',
      reason: 'Le camion T1 revient trop tard',
      to_truck: truck2,
    });
    expect(
      (
        await migrator.query(
          `select 1 from audit_event where table_name = 'trip_dispatch_change' and action = 'insert' and actor_user_id = $1`,
          [pmA.id],
        )
      ).rowCount,
    ).toBe(1);
    tripA2 = r.value.newTripId;
  });
  it("a rotation already started cannot be moved or postponed; a short reason is refused; another plant's manager cannot touch it", async () => {
    expect(
      await reassignTrip(
        app,
        pmA,
        { tripId: tripA1, truckId: truck2, driverId: null, reason: 'Trop tard' },
        { today: DAY },
      ),
    ).toEqual({ ok: false, error: 'STARTED' });
    expect(await postponeTrip(app, pmA, { tripId: tripA1, reason: 'Trop tard' })).toEqual({
      ok: false,
      error: 'STARTED',
    });
    expect(
      await reassignTrip(
        app,
        pmA,
        { tripId: tripA2, truckId: truck2, driverId: null, reason: 'x' },
        { today: DAY },
      ),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await refused(
        reassignTrip(
          app,
          pmB,
          { tripId: tripA2, truckId: truck2, driverId: null, reason: 'Pas ma centrale' },
          { today: DAY },
        ),
      ),
    ).toBe(true);
    expect(await refused(postponeTrip(app, pmB, { tripId: tripA2, reason: 'Pas ma centrale' }))).toBe(true);
    expect(
      await refused(
        reassignTrip(
          app,
          accountant,
          { tripId: tripA2, truckId: truck2, driverId: null, reason: 'Non autorisé' },
          { today: DAY },
        ),
      ),
    ).toBe(true);
  });
  it('postpones a rotation with a reason: it leaves the plan and the change is recorded', async () => {
    const r = await postponeTrip(app, pmA, { tripId: tripA2, reason: 'Le client demande demain matin' });
    expect(r.ok).toBe(true);
    expect(
      (await migrator.query(`select 1 from trip_plan_cancellation where trip_id = $1`, [tripA2])).rowCount,
    ).toBe(1);
    const log = await migrator.query<{ kind: string }>(
      `select kind from trip_dispatch_change where old_trip_id = $1`,
      [tripA2],
    );
    expect(log.rows[0]?.kind).toBe('postpone');
    expect(await refused(postponeTrip(app, pmA, { tripId: tripA2, reason: 'Déjà reporté' }))).toBe(true);
  });
  it("the change log is read like the delays: the owner and the plant's manager, nobody else", async () => {
    const n = async (u: SessionUser) =>
      Number(
        (
          await asRole(u, (tx) =>
            tx.query<{ n: string }>(
              `select count(*)::text as n from trip_dispatch_change where plant_id = $1`,
              [plantA],
            ),
          )
        ).rows[0]!.n,
      );
    expect(await n(owner)).toBeGreaterThanOrEqual(2);
    expect(await n(pmA)).toBeGreaterThanOrEqual(2);
    for (const u of [pmB, accountant, sales, purchases, driver1]) expect(await n(u), u.role).toBe(0);
  });
});

describe('the explanation never leaves the restricted tables (R14-02)', () => {
  const TEXT = `chauffeur en retard, panne ${marker}`;
  const needle = `%${TEXT}%`;
  const outsiders = () => [partner, support, accountant, sales, purchases, pmB, driver1];
  const count = async (u: SessionUser, sql: string) =>
    Number((await asRole(u, (tx) => tx.query<{ n: string }>(sql, [needle]))).rows[0]!.n);

  it('a reassignment and a postponement write codes in the plan and the cancellation, the text only in the change log', async () => {
    // a truck with a default driver, so that moving another driver onto it writes the plan's override reason
    expect((await setTruckDefaultDriver(app, owner, { truckId: truck2, driverId: driverRow1 })).ok).toBe(
      true,
    );
    const moved = await asOwner(plantA, async (tx) => {
      const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY);
      return o.id;
    });
    const t1 = await newTrip(plantA, scene.truckId, driverRow1, 700, 1, moved);
    // decision 207: the manager of plant A can plan only a driver who is attached to his plant: driverRow2 has a rotation at plant A (another day)
    await newTrip(plantA, scene.truckId, driverRow2, 300, 1, undefined, '2092-12-30');
    const r = await reassignTrip(
      app,
      pmA,
      { tripId: t1, truckId: truck2, driverId: driverRow2, reason: TEXT },
      { today: DAY },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const plan = await migrator.query<{ driver_override_reason: string | null }>(
      `select driver_override_reason from trip_plan where id = $1`,
      [r.value.newTripId],
    );
    expect(plan.rows[0]!.driver_override_reason).toBe('reassigned');
    const o2 = await asOwner(plantA, (tx) =>
      insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY),
    );
    const t2 = await newTrip(plantA, scene.truckId, driverRow2, 900, 1, o2.id);
    expect((await postponeTrip(app, pmA, { tripId: t2, reason: TEXT })).ok).toBe(true);
    const canc = await migrator.query<{ reason: string }>(
      `select reason from trip_plan_cancellation where trip_id = $1`,
      [t2],
    );
    expect(canc.rows[0]!.reason).toBe('postponed');
    // the text is in the change log, and nowhere else in the operational tables
    expect(
      (await migrator.query(`select 1 from trip_dispatch_change where reason = $1`, [TEXT])).rowCount,
    ).toBe(2);
    expect(
      (await migrator.query(`select 1 from trip_plan where driver_override_reason like $1`, [needle]))
        .rowCount,
    ).toBe(0);
    expect(
      (await migrator.query(`select 1 from trip_plan_cancellation where reason like $1`, [needle])).rowCount,
    ).toBe(0);
    // in the audit trail, only the audit copy of the change log holds it
    const where = await migrator.query<{ table_name: string }>(
      `select distinct table_name from audit_event where before::text like $1 or after::text like $1`,
      [needle],
    );
    expect(where.rows.map((x) => x.table_name)).toEqual(['trip_dispatch_change']);
  });

  it('partner, support and the others cannot reconstruct it from the plan, the cancellations or the audit', async () => {
    for (const u of outsiders()) {
      expect(
        await count(u, `select count(*)::text as n from trip_plan where driver_override_reason like $1`),
        u.role,
      ).toBe(0);
      expect(
        await count(u, `select count(*)::text as n from trip_plan_cancellation where reason like $1`),
        u.role,
      ).toBe(0);
      expect(
        await count(
          u,
          `select count(*)::text as n from audit_event where before::text like $1 or after::text like $1`,
        ),
        u.role,
      ).toBe(0);
    }
    // the owner and app_admin can: the explanation exists, in the restricted place
    for (const u of [owner, appAdmin])
      expect(
        await count(
          u,
          `select count(*)::text as n from audit_event where before::text like $1 or after::text like $1`,
        ),
        u.role,
      ).toBeGreaterThan(0);
    expect(
      await count(pmA, `select count(*)::text as n from trip_dispatch_change where reason like $1`),
    ).toBeGreaterThan(0);
  });

  it('rows written before this change, with the free text in the broader tables, are not readable through the audit either', async () => {
    // what the old code did: the explanation copied into the cancellation reason (the table is insert-only, so such rows cannot be rewritten)
    const o = await asOwner(plantA, (tx) =>
      insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY),
    );
    const legacy = await newTrip(plantA, scene.truckId, driverRow2, 1100, 1, o.id);
    await asOwner(plantA, (tx) =>
      tx.query(
        `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, $2, $3)`,
        [legacy, `Reporté : ${TEXT}`, owner.id],
      ),
    );
    for (const u of [partner, support, accountant, pmA, pmB, driver1, sales, purchases])
      expect(
        await count(
          u,
          `select count(*)::text as n from audit_event where table_name in ('trip_plan', 'trip_plan_cancellation', 'trip_event', 'trip_driver_report') and ($1::text is not null)`,
        ),
        u.role,
      ).toBe(0);
    expect(
      await count(
        owner,
        `select count(*)::text as n from audit_event where table_name = 'trip_plan_cancellation' and ($1::text is not null)`,
      ),
    ).toBeGreaterThan(0);
  });

  it("an estimate override's reason is read in its own table by the manager and the owner, in the audit by the owner only", async () => {
    const r = await setTripEstimate(app, pmA, {
      plantId: plantA,
      zoneId: null,
      stage: 'loading',
      minutes: 33,
      reason: TEXT,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    for (const u of [partner, support, accountant, pmB, driver1])
      expect(
        await count(
          u,
          `select count(*)::text as n from audit_event where table_name = 'trip_estimate_override' and after::text like $1`,
        ),
        u.role,
      ).toBe(0);
    expect(
      await count(
        owner,
        `select count(*)::text as n from audit_event where table_name = 'trip_estimate_override' and after::text like $1`,
      ),
    ).toBeGreaterThan(0);
  });
});

describe('the estimate reader authorizes positively and enforces scope itself (R14-05)', () => {
  const estimate = (u: SessionUser, plant: string | null, zone: string | null = null, stage = 'to_site') =>
    asRole(u, (tx) =>
      tx.query<{ minutes: number; source: string }>('select * from public.trip_stage_estimate($1, $2, $3)', [
        plant,
        zone,
        stage,
      ]),
    );
  const refusedEstimate = async (p: Promise<unknown>) =>
    p.then(
      () => false,
      (e: Error) => /may not read the estimate/.test(e.message),
    );
  let driver3: SessionUser;
  let driverRow3 = '';
  beforeAll(async () => {
    driver3 = await userRow('driver', null);
    driverRow3 = await newDriver(`Chauffeur trois ${marker}`, driver3);
  });

  it('a manager reads his own plant only; another plant, no plant and no role are refused', async () => {
    expect((await estimate(pmA, plantA)).rowCount).toBeGreaterThanOrEqual(0);
    expect(await refusedEstimate(estimate(pmB, plantA)), 'foreign plant manager').toBe(true);
    expect(await refusedEstimate(estimate(pmA, plantB)), 'the other plant').toBe(true);
    expect(await refusedEstimate(estimate(pmA, null)), 'a null plant').toBe(true);
    expect((await estimate(owner, plantB)).rowCount).toBeGreaterThanOrEqual(0);
    expect((await estimate(appAdmin, plantA)).rowCount).toBeGreaterThanOrEqual(0);
  });

  it('no role context is refused (the old test was NULL, not true, and fell through); neither are the roles that read no timing', async () => {
    for (const role of [undefined, '']) {
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.user_id', $1, true)`, [owner.id]);
        if (role !== undefined) await c.query(`select set_config('app.role', $1, true)`, [role]);
        await expect(
          c.query('select * from public.trip_stage_estimate($1, null, $2)', [plantA, 'to_site']),
          String(role),
        ).rejects.toThrow(/may not read the estimate/);
      } finally {
        await c.query('rollback');
        c.release();
      }
    }
    for (const u of [accountant, partner, support, sales, purchases])
      expect(await refusedEstimate(estimate(u, plantA)), u.role).toBe(true);
  });

  it('a driver reads only a plant and a route he is planned on', async () => {
    // driver1 is planned at plant A (no zone), driver2 at both plants (an earlier test moved a rotation to him), driver3 nowhere yet
    expect((await estimate(driver1, plantA)).rowCount).toBeGreaterThanOrEqual(0);
    expect(await refusedEstimate(estimate(driver1, plantB)), 'foreign plant').toBe(true);
    expect(await refusedEstimate(estimate(driver3, plantA)), 'foreign driver').toBe(true);
    expect(await refusedEstimate(estimate(driver3, plantB)), 'foreign driver, other plant').toBe(true);
    expect((await estimate(driver2, plantB)).rowCount).toBeGreaterThanOrEqual(0);
    expect(await refusedEstimate(estimate(driver1, plantA, randomUUID())), 'a route he is not on').toBe(true);
    expect(await refusedEstimate(estimate(driver1, null)), 'a null plant he is not on').toBe(true);
  });

  /** A completed rotation of plant A (no zone) by this driver, `d` minutes to site, written as the plant's tracking would. */
  async function completed(offset: number, driverId: string, d: number) {
    const o = await asOwner(plantA, (tx) =>
      insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY),
    );
    const t = await newTrip(plantA, scene.truckId, driverId, 300, 1, o.id);
    await sudo(`update trip_plan set trip_date = $2 where id = $1`, [t, addDays(DAY, offset)]);
    const base = new Date(localMidnightMs(addDays(DAY, offset)) + 6 * 3600_000);
    for (const [step, plus] of [
      ['departed', 0],
      ['arrived', d],
      ['unloading_started', d + 5],
      ['unloading_finished', d + 35],
      ['back', d + 65],
    ] as const)
      await sudo(
        `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`,
        [t, step, new Date(base.getTime() + plus * 60_000), SYSTEM_ACTOR_ID],
      );
  }

  it('a driver gets a median only with at least three different drivers behind it; the manager has no such floor', async () => {
    // the history test above left five completed rotations of plant A by ONE driver: enough for the manager, one person for a driver
    expect((await estimate(pmA, plantA)).rows[0]).toMatchObject({ source: 'history' });
    expect((await estimate(driver1, plantA)).rows[0]?.source, 'one driver behind the median').not.toBe(
      'history',
    );
    await completed(-1, driverRow2, 30);
    expect((await estimate(driver2, plantA)).rows[0]?.source, 'two drivers').not.toBe('history');
    await completed(-2, driverRow3, 28);
    for (const u of [driver1, driver2, driver3])
      expect((await estimate(u, plantA)).rows[0]?.source, `${u.role} with three drivers`).toBe('history');
    expect((await estimate(pmA, plantA)).rows[0]).toMatchObject({ source: 'history' });
  });
});
