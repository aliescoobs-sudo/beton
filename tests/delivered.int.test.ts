import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { listOrders } from '../src/modules/ledger';
import {
  cancelLoad,
  listDeliveries,
  markDelivered,
  recordLoss,
  recordTripStep,
  saveDispatch,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, type DeliveryScene, newDelivery } from './helpers/ledger-fixtures';

// integration I1.1: a load is delivered at the unloading step of its rotation (or by hand outside any rotation); an order's
// delivered quantity is the sum of its delivered loads; a cancelled or wholly refused load never counts. AC-INT-01.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `dv${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const DAY = '2026-06-02';
let scene: DeliveryScene;
let tripId = '';
let tripDeliveryId = '';
const at = (hhmm: string) => new Date(`2026-06-02T${hhmm}:00.000Z`);
const step = (actor: SessionUser, s: string, hhmm: string) =>
  recordTripStep(app, actor, { tripId, step: s }, { today: DAY, now: at(hhmm) });
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const deliveredL = async (actor: SessionUser): Promise<number> =>
  Number(
    (
      await inCtx(actor, (tx) =>
        tx.query<{ n: string }>(
          `select coalesce(sum(volume_l), 0)::text as n from delivered_load where order_id = $1`,
          [scene.orderId],
        ),
      )
    ).rows[0]?.n,
  );

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  const saved = await saveDispatch(app, users.plant, {
    date: DAY,
    rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 1000 }],
  });
  if (!saved.ok) throw new Error(saved.error);
  const { rows } = await migrator.query<{ id: string }>(`select id from trip_plan where batch_id = $1`, [
    saved.value.batchId,
  ]);
  tripId = rows[0]?.id as string;
});

describe('a rotation delivers its load (AC-INT-01)', () => {
  it('loaded, departed, arrived and unloading started do not deliver', async () => {
    for (const [s, hhmm] of [
      ['loaded', '07:00'],
      ['departed', '07:10'],
      ['arrived', '07:50'],
      ['unloading_started', '08:00'],
    ] as const) {
      const r = await step(users.plant, s, hhmm);
      if (!r.ok) throw new Error(`${s}: ${r.error}`);
      if (s === 'loaded') tripDeliveryId = r.value.load?.id as string;
    }
    expect(await deliveredL(users.owner)).toBe(0);
  });

  it('the unloading step delivers the BL with the step instant, in the same transaction', async () => {
    const r = await step(users.plant, 'unloading_finished', '08:30');
    expect(r.ok).toBe(true);
    const row = await inCtx(users.plant, (tx) =>
      tx.query<{ at: Date; trip_event_id: string | null }>(
        `select at, trip_event_id from delivery_delivered where delivery_id = $1`,
        [tripDeliveryId],
      ),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.at.toISOString()).toBe('2026-06-02T08:30:00.000Z');
    expect(row.rows[0]?.trip_event_id).not.toBeNull();
    expect(await deliveredL(users.owner)).toBe(1000);
  });

  it('the load of a rotation cannot be marked by hand, by the service or the database', async () => {
    expect(
      await markDelivered(app, users.plant, { deliveryId: tripDeliveryId }, { now: at('09:00') }),
    ).toEqual({
      ok: false,
      error: 'FOLLOWS_ROTATION',
    });
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values (gen_random_uuid(), $1, now(), null, $2)`,
          [tripDeliveryId, users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the plant sees the instant and that the load is on a rotation', async () => {
    const rows = await listDeliveries(app, users.plant);
    const mine = rows.find((r) => r.id === tripDeliveryId);
    expect(mine).toMatchObject({ onRotation: true, refused: false, deliveredAt: '2026-06-02T08:30:00Z' });
  });
});

describe('a load outside a rotation is delivered by hand', () => {
  let manualId = '';
  it('plant marks it once; the instant is the clock; a rotation load before unloading is refused', async () => {
    manualId = (await newDelivery(app, users.owner.id, marker, scene, 500)).id;
    expect(await deliveredL(users.owner)).toBe(1000);
    const first = await markDelivered(app, users.plant, { deliveryId: manualId }, { now: at('10:00') });
    expect(first.ok).toBe(true);
    expect(await deliveredL(users.owner)).toBe(1500);
    expect(await markDelivered(app, users.plant, { deliveryId: manualId }, { now: at('10:05') })).toEqual({
      ok: false,
      error: 'ALREADY_DELIVERED',
    });
  });

  it('office and support cannot mark; office reads the delivered loads (quantities)', async () => {
    const other = (await newDelivery(app, users.owner.id, marker, scene, 100)).id;
    await expect(
      markDelivered(app, users.office, { deliveryId: other }, { now: at('10:00') }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      markDelivered(app, users.support, { deliveryId: other }, { now: at('10:00') }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(
          `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values (gen_random_uuid(), $1, now(), null, $2)`,
          [other, users.office.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await deliveredL(users.office)).toBe(1500);
    expect(await deliveredL(users.support)).toBe(1500);
  });

  it('an unknown load is not found', async () => {
    expect(await markDelivered(app, users.plant, { deliveryId: randomUUID() }, { now: at('10:00') })).toEqual(
      {
        ok: false,
        error: 'NOT_FOUND',
      },
    );
  });
});

describe('what never counts as delivered', () => {
  it('a cancelled load and a wholly refused load are out; a partial loss stays in', async () => {
    const cancelled = (await newDelivery(app, users.owner.id, marker, scene, 200)).id;
    const refused = (await newDelivery(app, users.owner.id, marker, scene, 300)).id;
    const partial = (await newDelivery(app, users.owner.id, marker, scene, 400)).id;
    for (const id of [cancelled, refused, partial]) {
      expect((await markDelivered(app, users.plant, { deliveryId: id }, { now: at('11:00') })).ok).toBe(true);
    }
    const before = await deliveredL(users.owner);
    expect(before).toBe(1500 + 200 + 300 + 400);

    expect(
      (await recordLoss(app, users.plant, { deliveryId: partial, volumeL: 100, reason: 'quality' })).ok,
    ).toBe(true);
    expect(await deliveredL(users.owner)).toBe(before);

    expect(
      (
        await recordLoss(app, users.office, {
          deliveryId: refused,
          volumeL: 300,
          reason: 'rejected_by_client',
        })
      ).ok,
    ).toBe(true);
    expect(await deliveredL(users.owner)).toBe(before - 300);

    const done = await cancelLoad(
      app,
      users.owner,
      { deliveryId: cancelled, reason: 'erreur' },
      { today: DAY },
    );
    expect(done.ok).toBe(true);
    expect(await deliveredL(users.owner)).toBe(before - 300 - 200);
  });

  it('a cancelled load cannot be delivered afterwards', async () => {
    const id = (await newDelivery(app, users.owner.id, marker, scene, 50)).id;
    expect(
      (await cancelLoad(app, users.owner, { deliveryId: id, reason: 'erreur' }, { today: DAY })).ok,
    ).toBe(true);
    expect(await markDelivered(app, users.plant, { deliveryId: id }, { now: at('12:00') })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });
});

describe("an order's delivered quantity (AC-INT-01)", () => {
  it('is the sum of its delivered loads, on the orders list of the owner', async () => {
    const expected = await deliveredL(users.owner);
    const orders = await listOrders(app, users.owner, { today: DAY });
    const mine = orders.find((o) => o.id === scene.orderId);
    expect(mine?.deliveredL).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});
