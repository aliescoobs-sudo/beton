import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  getDispatchDay,
  listTrips,
  recordTripStep,
  saveDispatch,
  type TripView,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O10: trip tracking. AC-OPS-16 (steps in order, once each, with the clock's instant; refused out of order by the
// service and the database; two taps at once record one) and AC-OPS-17 (waiting time and the others derived from the events).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `tr${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const DAY = '2026-06-02';
let scene: DeliveryScene;
let tripId = '';
let blNo = '';

const at = (hhmm: string) => new Date(`2026-06-02T${hhmm}:00.000Z`);
const step = (actor: SessionUser, id: string, s: string, hhmm: string) =>
  recordTripStep(app, actor, { tripId: id, step: s }, { today: DAY, now: at(hhmm) });
const view = async (): Promise<TripView> => {
  const trips = await listTrips(app, users.plant, DAY);
  if (!trips.ok) throw new Error('list');
  const t = trips.value.find((x) => x.id === tripId);
  if (!t) throw new Error('trip not found');
  return t;
};

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  const saved = await saveDispatch(app, users.plant, {
    date: DAY,
    rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 8000 }],
  });
  if (!saved.ok) throw new Error(saved.error);
  const { rows } = await migrator.query<{ id: string }>(`select id from trip_plan where batch_id = $1`, [
    saved.value.batchId,
  ]);
  tripId = rows[0]?.id as string;
});

describe('who may see and tap (AC-OPS-16)', () => {
  it('tracking is for the owner and the plant only: office, partner and support are refused (T8)', async () => {
    for (const role of ['office', 'partner', 'support'] as const) {
      await expect(listTrips(app, users[role], DAY), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(step(users[role], tripId, 'loaded', '07:00'), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await listTrips(app, users.plant, DAY)).ok).toBe(true);
  });

  it('a rotation is not tracked yet: the next step is the load', async () => {
    const t = await view();
    expect(t.next).toBe('loaded');
    expect(t.events).toEqual({});
    expect(t.blNo).toBeNull();
  });
});

describe('the steps (AC-OPS-16, 17)', () => {
  it("the database's guard still refuses a direct insert out of order, and a plant manager has no direct insert at all (T9: every stage goes through record_trip_stage)", async () => {
    await expect(
      withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query(
          `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'departed', now(), $2)`,
          [tripId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('previous step') });
    await expect(
      withRlsContext(app, { userId: users.plant.id, role: 'plant', requestId: marker }, (tx) =>
        tx.query(
          `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'loaded', now(), $2)`,
          [tripId, users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the first tap loads: a BL, the stock goes down, the event links the load, with the clock instant', async () => {
    const r = await step(users.plant, tripId, 'loaded', '07:00');
    if (!r.ok) throw new Error(r.error);
    expect(r.value.load?.blNo).toMatch(/^BL-\d{4}-\d{5}$/);
    expect(r.value.load?.volumeL).toBe(8000);
    blNo = r.value.load?.blNo as string;
    const t = await view();
    expect(t.events.loaded).toBe('2026-06-02T07:00:00.000Z');
    expect(t.blNo).toBe(blNo);
    expect(t.next).toBe('departed');
    const stock = await migrator.query<{ n: string }>(
      `select count(*)::text as n from stock_movement m join delivery d on d.id = m.source_id where d.bl_no = $1`,
      [blNo],
    );
    expect(Number(stock.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('a step already recorded is answered with its record (who, when), and no second load is made', async () => {
    const again = await step(users.plant, tripId, 'loaded', '07:05');
    expect(again).toMatchObject({
      ok: true,
      value: { recorded: false, by: { source: 'plant', implicit: false, at: '2026-06-02T07:00:00.000Z' } },
    });
    const loads = await migrator.query<{ n: string }>(
      `select count(*)::text as n from delivery where order_id = $1 and volume_l > 0`,
      [scene.orderId],
    );
    expect(Number(loads.rows[0]?.n)).toBe(1);
  });

  it('waiting time on site, unloading, round trip and concrete age are derived from the events', async () => {
    for (const [s, hhmm] of [
      ['departed', '07:10'],
      ['arrived', '08:10'],
      ['unloading_started', '08:40'],
    ] as const) {
      const r = await step(users.plant, tripId, s, hhmm);
      expect(r.ok, s).toBe(true);
    }
    let t = await view();
    expect(t.times.waitingOnSiteMin).toBe(30);
    // nothing after: the figures that need a later step stay empty, never zero
    expect(t.times.unloadingMin).toBeNull();
    expect(t.times.roundTripMin).toBeNull();
    expect(t.times.concreteAgeMin).toBeNull();
    await step(users.plant, tripId, 'unloading_finished', '09:05');
    await step(users.plant, tripId, 'back', '10:00');
    t = await view();
    expect(t.times).toMatchObject({
      waitingOnSiteMin: 30,
      unloadingMin: 25,
      roundTripMin: 170,
      concreteAgeMin: 125,
    });
    expect(t.next).toBeNull();
    // a seventh tap has nothing left: the existing record comes back, nothing changes
    expect(await step(users.plant, tripId, 'back', '10:30')).toMatchObject({
      ok: true,
      value: { recorded: false },
    });
  });

  it('the view carries no price, total, client contact or payment', async () => {
    for (const role of ['plant', 'owner'] as const) {
      const trips = await listTrips(app, users[role], DAY);
      expectNoFields(trips, [
        'priceCentimes',
        'unitPriceHtCentimes',
        'totalTtcCentimes',
        'amountCentimes',
        'phone',
        'clientName',
        'planItems',
      ]);
    }
  });
});

describe('two taps at once (AC-OPS-16)', () => {
  it('record exactly one event, and one load', async () => {
    const orderScene = await deliveryScene(app, users.owner.id, `${marker}b`);
    const saved = await saveDispatch(app, users.plant, {
      date: DAY,
      rotations: [
        { orderId: orderScene.orderId, truckId: orderScene.truckId, driverId: null, volumeL: 4000 },
      ],
    });
    if (!saved.ok) throw new Error(saved.error);
    const { rows } = await migrator.query<{ id: string }>(`select id from trip_plan where batch_id = $1`, [
      saved.value.batchId,
    ]);
    const id = rows[0]?.id as string;
    const results = await Promise.all([
      step(users.plant, id, 'loaded', '11:00'),
      step(users.owner, id, 'loaded', '11:00'),
    ]);
    // both are answered (T9: a second tap is never an error); exactly one of them recorded the stage and made the load
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.recorded)).toHaveLength(1);
    const events = await withRlsContext(
      app,
      { userId: users.owner.id, role: 'owner', requestId: marker },
      (tx) => tx.query<{ n: string }>(`select count(*)::text as n from trip_event where trip_id = $1`, [id]),
    );
    // the stage, and the driver's "loading began" filled in before it
    expect(Number(events.rows[0]?.n)).toBe(2);
    const loads = await migrator.query<{ n: string }>(
      `select count(*)::text as n from delivery where order_id = $1 and volume_l > 0`,
      [orderScene.orderId],
    );
    expect(Number(loads.rows[0]?.n)).toBe(1);
  });
});

describe('T9: a later stage fills the skipped ones; the order of the instants never breaks', () => {
  it('departed tapped first fills loading began and loaded as implicit (no load is made); a step dated before the previous one is recorded at the previous instant', async () => {
    const other = await deliveryScene(app, users.owner.id, `${marker}c`);
    const saved = await saveDispatch(app, users.plant, {
      date: DAY,
      rotations: [{ orderId: other.orderId, truckId: other.truckId, driverId: null, volumeL: 4000 }],
    });
    if (!saved.ok) throw new Error(saved.error);
    const { rows } = await migrator.query<{ id: string }>(`select id from trip_plan where batch_id = $1`, [
      saved.value.batchId,
    ]);
    const id = rows[0]?.id as string;
    const departed = await step(users.plant, id, 'departed', '11:00');
    expect(departed).toMatchObject({ ok: true, value: { recorded: true, load: null } });
    const stored = await migrator.query<{ step: string; implicit: boolean; delivery_id: string | null }>(
      `select step, implicit, delivery_id from trip_event where trip_id = $1 order by created_at`,
      [id],
    );
    expect(stored.rows.map((r) => [r.step, r.implicit, r.delivery_id])).toEqual([
      ['loading_started', true, null],
      ['loaded', true, null],
      ['departed', false, null],
    ]);
    const loads = await migrator.query<{ n: string }>(
      `select count(*)::text as n from delivery where order_id = $1`,
      [other.orderId],
    );
    expect(Number(loads.rows[0]?.n)).toBe(0); // the plant's own load was not made by a stage
    const early = await step(users.plant, id, 'arrived', '10:50'); // the writer's clock is behind
    expect(early).toMatchObject({
      ok: true,
      value: { recorded: true, by: { at: '2026-06-02T11:00:00.000Z' } },
    });
    // the plant then makes its own load: it is attached to the implicit stage
    const made = await step(users.plant, id, 'loaded', '11:30');
    expect(made).toMatchObject({ ok: true, value: { recorded: true } });
    if (made.ok) expect(made.value.load?.blNo).toMatch(/^BL-/);
    const linked = await migrator.query<{ delivery_id: string | null; implicit: boolean }>(
      `select delivery_id, implicit from trip_event where trip_id = $1 and step = 'loaded'`,
      [id],
    );
    expect(linked.rows[0]?.delivery_id).not.toBeNull();
    expect(linked.rows[0]?.implicit).toBe(true); // the stage keeps its history; only the load was attached
  });
});

describe('a rotation that has started stays when the day is replanned', () => {
  it('replanning keeps it live, shows it as started, and the database refuses to cancel it', async () => {
    const day = await getDispatchDay(app, users.plant, DAY);
    if (!day.ok) throw new Error('day');
    const started = day.value.saved.find((s) => s.key === tripId);
    expect(started?.started).toBe(true);
    // replanning the day (here: with the second order only) does not cancel the started rotation
    const again = await saveDispatch(app, users.plant, {
      date: DAY,
      rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 2000 }],
    });
    expect(again.ok).toBe(true);
    const after = await getDispatchDay(app, users.plant, DAY);
    if (!after.ok) throw new Error('day');
    expect(after.value.saved.some((s) => s.key === tripId && s.started)).toBe(true);
    await expect(
      withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query(
          `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'replanned', $2)`,
          [tripId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('has started') });
  });

  it('trip_event has no UPDATE or DELETE for the application role', async () => {
    const { rows } = await migrator.query<{ u: boolean; d: boolean }>(
      `select has_table_privilege('belgobeton_app', 'public.trip_event', 'UPDATE') as u,
              has_table_privilege('belgobeton_app', 'public.trip_event', 'DELETE') as d`,
    );
    expect(rows[0]).toEqual({ u: false, d: false });
  });
});
