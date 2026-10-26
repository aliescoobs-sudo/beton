import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { getOfficeDispatch, saveDispatch } from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// integration I4.2: office's read-only dispatch, enforced by the database: one reviewed function, no direct read of the plan or
// the orders, no price or amount in what it returns. AC-INT-21 (DECISIONS 91, Ali).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `od${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const DAY = '2026-06-02';
let scene: DeliveryScene;
let clientName: string;

const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker);
  clientName = (
    await inCtx(users.owner, (tx) =>
      tx.query<{ name: string }>(
        'select c.name from client c join sales_order o on o.client_id = c.id where o.id = $1',
        [scene.orderId],
      ),
    )
  ).rows[0]?.name as string;
  const saved = await saveDispatch(app, users.plant, {
    date: DAY,
    rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 2000 }],
  });
  if (!saved.ok) throw new Error(saved.error);
});

const mine = async (role: 'office' | 'plant') => {
  const r = await getOfficeDispatch(app, users[role], DAY);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('what office reads (AC-INT-21)', () => {
  it("office sees the day's rotation with truck, times, litres and the client's name, planned and not yet driven", async () => {
    const rows = await getOfficeDispatch(app, users.office, DAY);
    if (!rows.ok) throw new Error(rows.error);
    const row = rows.value.find((r) => r.clientName === clientName);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ volumeL: 2000, step: null, blNo: null });
    expect(row?.truckCode).toMatch(/^T\d+$/);
    expect(row?.loadMin).toBeLessThanOrEqual(row?.backMin ?? 0);
  });

  it('carries no price, total, payment, plan item or order number', async () => {
    const rows = await mine('office').catch(() => []);
    expect(rows.length).toBeGreaterThan(0);
    expectNoFields(rows, [
      'priceCentimes',
      'unitPriceHtCentimes',
      'totalTtcCentimes',
      'amountCentimes',
      'planItems',
      'orderCode',
      'orderId',
      'clientCode',
      'phone',
    ]);
    const raw = await inCtx(users.office, (tx) =>
      tx.query('select * from public.dispatch_office($1::date)', [DAY]),
    );
    expect(raw.fields.map((f) => f.name).sort()).toEqual(
      [
        'arrive_min',
        'back_min',
        'bl_no',
        'client_name',
        'depart_min',
        'load_min',
        'seq',
        'site_label',
        'step',
        'trip_date',
        'trip_id',
        'truck_code',
        'truck_plate',
        'unload_end_min',
        'volume_l',
        'zone_name',
      ].sort(),
    );
  });

  it('a cancelled (replanned) rotation is not shown', async () => {
    const before = (await mine('office')).length;
    const again = await saveDispatch(app, users.plant, {
      date: DAY,
      rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 3000 }],
    });
    expect(again.ok).toBe(true);
    const after = await mine('office');
    expect(after.length).toBe(before);
    expect(after.some((r) => r.volumeL === 3000)).toBe(true);
    expect(after.some((r) => r.volumeL === 2000)).toBe(false);
  });
});

describe('what the database refuses office (AC-INT-21)', () => {
  it('office cannot read the plan, the tracking, the orders or the deliveries directly', async () => {
    for (const table of ['trip_plan', 'trip_event', 'trip_plan_cancellation', 'sales_order', 'delivery']) {
      const rows = await inCtx(users.office, (tx) => tx.query(`select * from ${table}`)).then(
        (r) => r.rowCount,
        () => 'denied',
      );
      // `delivery` is read by every role (quantities, BL numbers); the plan, the tracking and the orders by none of office's
      if (table === 'delivery') continue;
      expect(rows === 0 || rows === 'denied', table).toBe(true);
    }
  });

  it('office cannot write the plan, nor its own view of it', async () => {
    await expect(
      saveDispatch(app, users.office, {
        date: DAY,
        rotations: [{ orderId: scene.orderId, truckId: scene.truckId, driverId: null, volumeL: 1000 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.office, (tx) => tx.query(`update trip_plan set volume_l = 1 where true`)),
    ).rejects.toBeDefined();
  });

  it('the page permission is office only; the function itself also answers the roles that read the plan, and nobody else', async () => {
    await expect(getOfficeDispatch(app, users.plant, DAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOfficeDispatch(app, users.owner, DAY)).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ['owner', 'partner', 'plant', 'support'] as const) {
      const r = await inCtx(users[role], (tx) =>
        tx.query('select * from public.dispatch_office($1::date)', [DAY]),
      );
      expect(r.rowCount, role).toBeGreaterThan(0);
    }
    await expect(
      withRlsContext(
        app,
        { userId: '00000000-0000-7000-8000-000000000000', role: 'anonymous', requestId: marker },
        (tx) => tx.query('select * from public.dispatch_office($1::date)', [DAY]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a date that is not a date', async () => {
    expect(await getOfficeDispatch(app, users.office, '2026-13-45')).toEqual({ ok: false, error: 'INVALID' });
    expect(await getOfficeDispatch(app, users.office, "2026-06-02'; drop table x;--")).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });
});
