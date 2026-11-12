import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createTruck, fieldCipherFrom } from '../src/modules/master-data';
import {
  getPumpCoordination,
  listPumpOptions,
  reschedulePumpJob,
  resolvePumpConflict,
  schedulePumpJob,
  setOrderPumped,
} from '../src/modules/operations';
import { ForbiddenError, listMyNotifications } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, insertOrder, orderMaster, type DeliveryScene } from './helpers/ledger-fixtures';
import { freeDriverCode } from './helpers/codes';

// C3 (REQUIREMENTS-V1 §16.6, basic): a pumped pour needs a pump scheduled on site before any truck is planned for it; a truck planned
// to arrive before the pump is ready and a pump booked twice raise a conflict and an alert. Times and quantities only.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const marker = 'pc' + randomUUID().replace(/-/g, '').slice(0, 8);
const cipher = fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS));
const DAY = '2026-06-03';
let owner: SessionUser,
  sales: SessionUser,
  purchases: SessionUser,
  accountant: SessionUser,
  driver: SessionUser;
let scene: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
let operator: string;

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, fn);

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  sales = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_sales');
  purchases = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_purchases');
  accountant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'accountant');
  driver = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'driver');
  scene = await deliveryScene(app, owner.id, marker, DAY);
  master = await orderMaster(app, owner.id, marker);
  const opCode = await freeDriverCode();
  const op = await asOwner((tx) =>
    tx.query<{ id: string }>(
      `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'pump_operator') returning id`,
      [opCode, `Opérateur ${marker}`, owner.id],
    ),
  );
  operator = op.rows[0]!.id;
});
afterAll(async () => {
  await Promise.all([app.end(), migrator.end()]);
});

/** A pump truck of its own, so that the tests of this file never book the same pump over the same time. */
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
const newOrder = () =>
  asOwner((tx) => insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DAY));
/** A rotation of an order arriving at `arrive` (minutes since midnight). */
const trip = (orderId: string, arrive: number) =>
  asOwner((tx) =>
    tx.query<{ id: string }>(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, null, 8000, $4, $5, $6, $7, $8, $9) returning id`,
      [DAY, orderId, scene.truckId, arrive - 60, arrive - 40, arrive, arrive + 30, arrive + 70, owner.id],
    ),
  );
const schedule = async (
  who: SessionUser,
  orderId: string | null,
  onSite: number,
  extra: object = {},
  pumpId?: string,
) =>
  schedulePumpJob(
    app,
    who,
    {
      date: DAY,
      pumpId: pumpId ?? (await newPump()),
      operatorId: operator,
      orderId,
      onSiteMin: onSite,
      siteLabel: 'Chantier pompe',
      plannedM3: 30,
      ...extra,
    },
    cipher,
  );
const conflictsOf = async (orderId: string) =>
  (
    await migrator.query(
      `select kind, resolved_at from pump_conflict where order_id = $1 order by created_at`,
      [orderId],
    )
  ).rows;

describe('a pumped pour needs a pump on site before a truck (C3, §16.6)', () => {
  it('an order that is not pumped plans its trucks as before', async () => {
    const o = await newOrder();
    expect((await trip(o.id, 480)).rowCount).toBe(1);
  });

  it('a pumped order refuses a truck until a pump is scheduled on site; then the truck is accepted', async () => {
    const o = await newOrder();
    expect(await setOrderPumped(app, sales, { orderId: o.id, pumped: true })).toEqual({
      ok: true,
      value: true,
    });
    await expect(trip(o.id, 480)).rejects.toThrow(/no pump is scheduled on site/);
    expect((await getPumpCoordination(app, sales, DAY)).waiting.map((w) => w.orderCode)).toContain(o.code);
    const made = await schedule(sales, o.id, 7 * 60 + 30); // on site 07:30, ready 08:00
    if (!made.ok) throw new Error(made.error);
    expect((await getPumpCoordination(app, sales, DAY)).waiting.map((w) => w.orderCode)).not.toContain(
      o.code,
    );
    expect((await trip(o.id, 8 * 60 + 30)).rowCount).toBe(1); // 08:30, after the pump is ready
    expect(await conflictsOf(o.id)).toEqual([]);
  });

  it('a truck planned to arrive before the pump is ready is allowed, recorded as a conflict, and alerted', async () => {
    const o = await newOrder();
    await schedule(sales, o.id, 8 * 60); // ready 08:30
    const before = (await listMyNotifications(app, owner, 100)).filter(
      (x) => x.kind === 'day_conflict',
    ).length;
    expect((await trip(o.id, 8 * 60)).rowCount).toBe(1); // 08:00, pump not ready
    const rows = await conflictsOf(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'truck_before_pump', resolved_at: null });
    expect((await listMyNotifications(app, owner, 100)).filter((x) => x.kind === 'day_conflict').length).toBe(
      before + 1,
    );
    const day = await getPumpCoordination(app, sales, DAY);
    expect(day.conflicts.find((c) => c.orderCode === o.code)).toMatchObject({
      kind: 'truck_before_pump',
      tripArriveMin: 480,
    });
    expect(day.board.find((j) => j.orderCode === o.code)).toMatchObject({
      onSiteMin: 480,
      setupMin: 30,
      firstTruckArriveMin: 480,
      openConflicts: 1,
    });
  });

  it('scheduling a pump after the trucks were planned flags the trucks that arrive too early', async () => {
    const o = await newOrder();
    await trip(o.id, 7 * 60); // no pump marked yet: accepted
    await schedule(sales, o.id, 7 * 60); // pump on site 07:00, ready 07:30; truck arrives 07:00
    expect((await conflictsOf(o.id)).map((c) => c.kind)).toEqual(['truck_before_pump']);
  });

  it('a pump booked twice over the same time is a conflict; another pump is not', async () => {
    const shared = await newPump();
    const other = await newPump();
    const o1 = await newOrder();
    const o2 = await newOrder();
    await schedule(sales, o1.id, 10 * 60, { durationMin: 120 }, shared); // 10:00 to 12:30 with the 30 minutes of set-up
    expect((await schedule(sales, o2.id, 11 * 60, { durationMin: 60 }, shared)).ok).toBe(true); // 11:00: overlaps
    expect((await conflictsOf(o2.id)).map((c) => c.kind)).toEqual(['pump_double_booked']);
    const o3 = await newOrder();
    await schedule(sales, o3.id, 11 * 60, { durationMin: 60 }, other);
    expect(await conflictsOf(o3.id)).toEqual([]);
    const o4 = await newOrder();
    await schedule(sales, o4.id, 13 * 60, {}, shared); // after the first one ended (12:30): fine
    expect(await conflictsOf(o4.id)).toEqual([]);
  });

  it('moving the pump re-checks the trucks: the old conflict is closed, a new one opens if it still holds', async () => {
    const o = await newOrder();
    const made = await schedule(sales, o.id, 6 * 60); // ready 06:30
    if (!made.ok) throw new Error(made.error);
    await trip(o.id, 7 * 60); // fine
    expect(await conflictsOf(o.id)).toEqual([]);
    expect(await reschedulePumpJob(app, sales, { jobId: made.value.id, onSiteMin: 7 * 60 })).toEqual({
      ok: true,
      value: true,
    }); // ready 07:30 > 07:00
    expect((await conflictsOf(o.id)).map((c) => c.kind)).toEqual(['truck_before_pump']);
    // moving it again closes that one and (the truck is still early) opens a fresh one
    await reschedulePumpJob(app, sales, { jobId: made.value.id, onSiteMin: 8 * 60 });
    const rows = await conflictsOf(o.id);
    expect(rows.filter((r) => r.resolved_at === null)).toHaveLength(1);
    // a conflict can be closed by hand
    const open = (await getPumpCoordination(app, sales, DAY)).conflicts.find(
      (c) => c.orderCode === o.code && !c.resolvedAt,
    )!;
    expect(await resolvePumpConflict(app, sales, open.id)).toEqual({ ok: true, value: true });
    expect(await resolvePumpConflict(app, sales, open.id)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('the office marks an order pumped by its code, without reading orders', async () => {
    const o = await newOrder();
    expect(await setOrderPumped(app, sales, { orderCode: o.code, pumped: true })).toEqual({
      ok: true,
      value: true,
    });
    await expect(trip(o.id, 600)).rejects.toThrow(/no pump is scheduled on site/);
    expect(await setOrderPumped(app, sales, { orderCode: 'CMD-2099-99999', pumped: true })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await setOrderPumped(app, sales, { orderCode: 'not a code', pumped: true })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    // taking the mark off lets the trucks be planned again
    expect(await setOrderPumped(app, sales, { orderCode: o.code, pumped: false })).toEqual({
      ok: true,
      value: true,
    });
    expect((await trip(o.id, 600)).rowCount).toBe(1);
  });

  it('an order cannot lose its pump mark while a pump is scheduled for it', async () => {
    const o = await newOrder();
    await schedule(sales, o.id, 9 * 60);
    expect(await setOrderPumped(app, sales, { orderId: o.id, pumped: false })).toEqual({
      ok: false,
      error: 'HAS_PUMP',
    });
  });

  it('is planned by the sales office, the owner roles and the plant; read by support too; nobody else', async () => {
    const mine = await newPump();
    expect((await listPumpOptions(app, sales)).pumps.map((p) => p.id)).toContain(mine);
    expect((await listPumpOptions(app, sales)).operators.map((p) => p.id)).toContain(operator);
    for (const who of [purchases, accountant, driver]) {
      await expect(getPumpCoordination(app, who, DAY)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setOrderPumped(app, who, { orderId: randomUUID(), pumped: true })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    const o = await newOrder();
    expect((await schedule(sales, o.id, 5 * 60, {}, randomUUID())).ok).toBe(false); // not a pump truck
    expect((await schedule(sales, o.id, 5 * 60, { operatorId: randomUUID() })).ok).toBe(false);
    expect(JSON.stringify(await getPumpCoordination(app, sales, DAY))).not.toMatch(
      /price|centimes|amount|total/i,
    );
  });
});
