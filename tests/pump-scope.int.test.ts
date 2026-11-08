import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, createTruck, fieldCipherFrom, updatePlant } from '../src/modules/master-data';
import {
  getPumpCoordination,
  listRedirectCandidates,
  openTripCase,
  reschedulePumpJob,
  resolvePumpConflict,
  schedulePumpJob,
  setOrderPumped,
} from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
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

// D1 / F01 (CODEX-REVIEW-FINAL): a plant manager reads and writes the pump surface of his own plant only, and the same holds for
// the emergency instructions and the redirect candidates. Two plants, one manager each.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `ps${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const cipher = fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const DAY = '2026-07-14';
const NOW = new Date('2026-07-14T09:00:00Z');
let done: () => Promise<void>;
let owner: SessionUser, pmA: SessionUser, pmB: SessionUser;
let plantA = '',
  plantB = '';
let sceneA: DeliveryScene, sceneB: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
let operator = '';

const asOwner = <T>(plant: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plant]);
    return fn(tx);
  });
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
  pmA = v.session('plant_manager');
  sceneA = await asOwner(plantA, () => deliveryScene(app, owner.id, `${marker}a`, DAY));
  master = await orderMaster(app, owner.id, `${marker}a`);
  const b = await createPlant(app, owner, { code: letters(6), name: `PSB ${marker}` });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  // A free code among the random ones other test files also draw (the database is shared).
  let truckBId = '';
  for (let tries = 0; tries < 30 && !truckBId; tries++) {
    const made = await createTruck(app, owner, {
      code: `T${100 + Math.floor(Math.random() * 890)}`,
      plate: `TB-${marker.slice(0, 8)}-${tries}`,
      plantId: plantB,
    });
    if (made.ok) truckBId = made.value.id;
  }
  if (!truckBId) throw new Error('no free truck code');
  sceneB = { ...sceneA, truckId: truckBId };
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, 'plant_manager', 'fr', 'active', true, now(), $4)`,
    [id, `${marker} pmB`, `${marker}-pmb-${id}@kayas.test`, plantB],
  );
  pmB = { ...v.session('plant_manager'), id, name: `${marker} pmB`, email: `${id}@kayas.test` };
  operator = (
    await asOwner(plantA, (tx) =>
      tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id`,
        [`CH-${6000 + Math.floor(Math.random() * 3000)}`, `Opérateur ${marker}`, owner.id],
      ),
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

const newOrder = (plant: string, scene: DeliveryScene) =>
  asOwner(plant, (tx) => insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY));
async function newPump(): Promise<string> {
  for (let tries = 0; tries < 30; tries++) {
    const code = `P${100 + Math.floor(Math.random() * 890)}`;
    const t = await createTruck(app, owner, {
      code,
      plate: `PUMP-${code}-${marker.slice(0, 5)}-${tries}`,
      kind: 'pump',
    });
    if (t.ok) return t.value.id;
  }
  throw new Error('no free pump code');
}
const schedule = async (who: SessionUser, orderId: string | null, onSite: number, pumpId?: string) =>
  schedulePumpJob(
    app,
    who,
    {
      date: DAY,
      pumpId: pumpId ?? (await newPump()),
      operatorId: operator,
      orderId,
      onSiteMin: onSite,
      siteLabel: `Chantier ${marker}`,
      plannedM3: 20,
    },
    cipher,
  );

describe('the pump surface is scoped to the plant of the manager (F01)', () => {
  let orderA: { id: string; code: string };
  let orderB: { id: string; code: string };
  let jobA = '';
  let jobB = '';
  it('a job takes the plant of its order; a manager cannot schedule a job of another plant order', async () => {
    orderA = await newOrder(plantA, sceneA);
    orderB = await newOrder(plantB, sceneB);
    const a = await schedule(owner, orderA.id, 480);
    const b = await schedule(owner, orderB.id, 480);
    if (!a.ok || !b.ok) throw new Error('schedule');
    jobA = a.value.id;
    jobB = b.value.id;
    expect(
      (await migrator.query<{ plant_id: string }>(`select plant_id from pump_job where id = $1`, [jobB]))
        .rows[0]!.plant_id,
    ).toBe(plantB);
    expect(await refused(schedule(pmA, orderB.id, 500))).toBe(true);
    // a job with no order takes the plant of the manager who schedules it
    const own = await schedule(pmA, null, 600);
    if (!own.ok) throw new Error(own.error);
    expect(
      (
        await migrator.query<{ plant_id: string }>(`select plant_id from pump_job where id = $1`, [
          own.value.id,
        ])
      ).rows[0]!.plant_id,
    ).toBe(plantA);
  });

  it('the board, the waiting list and the conflicts show only the plant of the manager', async () => {
    const day = await getPumpCoordination(app, pmA, DAY);
    const jobs = day.board.map((r) => r.jobId);
    expect(jobs).toContain(jobA);
    expect(jobs).not.toContain(jobB);
    expect(JSON.stringify(day)).not.toContain(orderB.code);
    const dayB = await getPumpCoordination(app, pmB, DAY);
    expect(dayB.board.map((r) => r.jobId)).toEqual([jobB]);
    // the owner (not bound to a plant) sees both
    const all = (await getPumpCoordination(app, owner, DAY)).board.map((r) => r.jobId);
    expect(all).toEqual(expect.arrayContaining([jobA, jobB]));
  });

  it('every write on another plant is refused: marking an order, moving a job, resolving a conflict', async () => {
    expect(await refused(setOrderPumped(app, pmA, { orderId: orderB.id, pumped: true }))).toBe(true);
    expect(await refused(setOrderPumped(app, pmA, { orderCode: orderB.code, pumped: true }))).toBe(true);
    expect(await refused(reschedulePumpJob(app, pmA, { jobId: jobB, onSiteMin: 700 }))).toBe(true);
    expect((await reschedulePumpJob(app, pmB, { jobId: jobB, onSiteMin: 700 })).ok).toBe(true);
    expect((await setOrderPumped(app, pmA, { orderId: orderA.id, pumped: true })).ok).toBe(true);
    // a conflict of plant B: the same pump booked twice over the same time
    const pump = await newPump();
    const o2 = await newOrder(plantB, sceneB);
    expect((await schedule(owner, orderB.id, 900, pump)).ok).toBe(true);
    expect((await schedule(owner, o2.id, 900, pump)).ok).toBe(true);
    const conflict = (await getPumpCoordination(app, owner, DAY)).conflicts.find(
      (c) => c.kind === 'pump_double_booked' && !c.resolvedAt,
    );
    expect(conflict).toBeTruthy();
    expect((await getPumpCoordination(app, pmA, DAY)).conflicts.map((c) => c.id)).not.toContain(conflict!.id);
    expect(await refused(resolvePumpConflict(app, pmA, conflict!.id))).toBe(true);
    expect((await resolvePumpConflict(app, pmB, conflict!.id)).ok).toBe(true);
  });

  it('the application role cannot read the other plant pump rows directly either', async () => {
    const rows = await withRlsContext(
      app,
      { userId: pmA.id, role: 'plant_manager', requestId: marker },
      async (tx) => ({
        jobs: (await tx.query<{ id: string }>('select id from pump_job')).rows.map((r) => r.id),
        pumped: (await tx.query<{ order_id: string }>('select order_id from order_pump')).rows.map(
          (r) => r.order_id,
        ),
        conflicts: (await tx.query<{ job_id: string }>('select job_id from pump_conflict')).rows.map(
          (r) => r.job_id,
        ),
      }),
    );
    expect(rows.jobs).toContain(jobA);
    expect(rows.jobs).not.toContain(jobB);
    expect(rows.pumped).not.toContain(orderB.id);
    expect(rows.conflicts).not.toContain(jobB);
  });
});

describe('the emergency instruction and the redirect candidates follow the same scope (F01)', () => {
  it('a manager cannot instruct the driver of another plant rotation nor list its redirect candidates', async () => {
    const order = await newOrder(plantB, sceneB);
    const target = await newOrder(plantB, sceneB);
    void target;
    const { tripId } = await asOwner(plantB, async (tx) => {
      const t = await tx.query<{ id: string }>(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by, plant_id)
         values (gen_random_uuid(), gen_random_uuid(), $4, $1, 1, $2, null, 8000, 420, 430, 455, 485, 520, $3, $5) returning id`,
        [order.id, sceneB.truckId, owner.id, DAY, plantB],
      );
      const delivery = await insertDelivery(
        tx,
        owner.id,
        { orderId: order.id, truckId: sceneB.truckId, recetteId: sceneB.recetteId },
        8000,
      );
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', $2, $3, $4)`,
        [t.rows[0]!.id, new Date(NOW.getTime() - 20 * 60_000).toISOString(), delivery.id, owner.id],
      );
      return { tripId: t.rows[0]!.id };
    });
    const opened = await openTripCase(app, owner, { tripId, caseNo: 3 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    expect(await refused(listRedirectCandidates(app, pmA, opened.value.id, { now: NOW }))).toBe(true);
    expect(
      (await listRedirectCandidates(app, pmB, opened.value.id, { now: NOW })).length,
    ).toBeGreaterThanOrEqual(0);
    // an emergency on that rotation: the driver of another plant is not the manager's to instruct
    const driver = (
      await asOwner(plantB, (tx) =>
        tx.query<{ id: string }>(
          `insert into driver (id, code, name, created_by) values (gen_random_uuid(), $1, $2, $3) returning id`,
          [`CH-${3000 + Math.floor(Math.random() * 2999)}`, `Chauffeur ${marker}`, owner.id],
        ),
      )
    ).rows[0]!.id;
    const emergency = (
      await withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query<{ id: string }>(
          `insert into trip_emergency (id, trip_id, driver_id, step, option, at, client_key)
           values (gen_random_uuid(), $1, $2, 'loaded', 'breakdown', now(), $3) returning id`,
          [tripId, driver, `${marker}-em-0001`],
        ),
      )
    ).rows[0]!.id;
    const call = (as: SessionUser) =>
      withRlsContext(app, { userId: as.id, role: as.role as never, requestId: marker }, (tx) =>
        tx.query(`select public.emergency_instruct($1, 'continue', null, null, 'ok', null)`, [emergency]),
      );
    await expect(call(pmA)).rejects.toThrow(/another plant/);
    await expect(call(pmB)).resolves.toBeTruthy();
  });
});

// R11-05: the scope check fails closed for NULL plants, and the redirect candidates are filtered row by row.
describe('NULL plant rows are denied to a plant manager, in the mutation doors and in the candidates (R11-05)', () => {
  /** The fixtures cannot be made through the doors (they refuse a plant-less row), so the plant is removed afterwards, triggers off. */
  const unassign = async (table: 'sales_order' | 'trip_plan', id: string) => {
    const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
    await c.connect();
    try {
      await c.query('set session_replication_role = replica');
      await c.query(`update ${table} set plant_id = null where id = $1`, [id]);
    } finally {
      await c.end();
    }
  };
  const tripOf = (orderId: string) =>
    asOwner(plantA, async (tx) => {
      const t = await tx.query<{ id: string }>(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by, plant_id)
         values (gen_random_uuid(), gen_random_uuid(), $4, $1, 1, $2, null, 8000, 420, 430, 455, 485, 520, $3, $5) returning id`,
        [orderId, sceneA.truckId, owner.id, DAY, plantA],
      );
      const delivery = await insertDelivery(
        tx,
        owner.id,
        { orderId, truckId: sceneA.truckId, recetteId: sceneA.recetteId },
        8000,
      );
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', $2, $3, $4)`,
        [t.rows[0]!.id, new Date(NOW.getTime() - 20 * 60_000).toISOString(), delivery.id, owner.id],
      );
      return t.rows[0]!.id;
    });
  const scopeOf = (who: SessionUser, plant: string | null) =>
    withRlsContext(
      app,
      { userId: who.id, role: who.role as never, requestId: marker },
      async (tx) =>
        (await tx.query<{ r: boolean | null }>('select public._pump_in_scope($1::uuid) as r', [plant]))
          .rows[0]!.r,
    );

  it('_pump_in_scope answers a definite boolean: false for a manager on NULL or another plant, true for the owner', async () => {
    expect(await scopeOf(pmA, plantA)).toBe(true);
    expect(await scopeOf(pmA, plantB)).toBe(false);
    expect(await scopeOf(pmA, null)).toBe(false); // was NULL: "IF NOT NULL" never raised
    expect(await scopeOf(owner, null)).toBe(true);
    expect(await scopeOf(owner, plantB)).toBe(true);
  });

  it('a manager cannot schedule, nor mark pumped, an order that has no plant; the owner can', async () => {
    const orphan = await newOrder(plantA, sceneA);
    await unassign('sales_order', orphan.id);
    expect(await refused(schedule(pmA, orphan.id, 1000))).toBe(true);
    expect(await refused(setOrderPumped(app, pmA, { orderId: orphan.id, pumped: true }))).toBe(true);
    expect(await refused(setOrderPumped(app, pmA, { orderCode: orphan.code, pumped: true }))).toBe(true);
    expect((await setOrderPumped(app, owner, { orderId: orphan.id, pumped: true })).ok).toBe(true);
    expect((await schedule(owner, orphan.id, 1010)).ok).toBe(true);
  });

  it('redirect candidates: a manager of the case plant never gets an unassigned order; the owner still does', async () => {
    const order = await newOrder(plantA, sceneA);
    const own = await newOrder(plantA, sceneA);
    const orphan = await newOrder(plantA, sceneA);
    await unassign('sales_order', orphan.id);
    const tripId = await tripOf(order.id);
    const opened = await openTripCase(app, owner, { tripId, caseNo: 3 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    const codes = async (who: SessionUser) =>
      (await listRedirectCandidates(app, who, opened.value.id, { now: NOW })).map((c) => c.orderCode);
    const mine = await codes(pmA);
    expect(mine).toContain(own.code);
    expect(mine).not.toContain(orphan.code);
    const all = await codes(owner);
    expect(all).toEqual(expect.arrayContaining([own.code, orphan.code]));
  });

  it("a case with no plant is not the manager's: its candidates are refused", async () => {
    const order = await newOrder(plantA, sceneA);
    await newOrder(plantA, sceneA);
    const tripId = await tripOf(order.id);
    await unassign('trip_plan', tripId);
    const opened = await openTripCase(app, owner, { tripId, caseNo: 3 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    expect(await refused(listRedirectCandidates(app, pmA, opened.value.id, { now: NOW }))).toBe(true);
    expect((await listRedirectCandidates(app, owner, opened.value.id, { now: NOW })).length).toBeGreaterThan(
      0,
    );
  });
});
