import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, updatePlant } from '../src/modules/master-data';
import {
  closeDay,
  getDayCloseStatus,
  getFuelTankLevels,
  setFuelTankOpening,
  getOrderTimeline,
  listDayCloses,
  listTransfers,
  pickUpTransfer,
  receiveTransfer,
  sendTransfer,
} from '../src/modules/operations';
import { inRequest, listMyNotifications } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  type DeliveryScene,
} from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// Batch B §16.5, §16.8, §16.9: transfers between the plants, the timeline of an order, the day close per plant.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
let done: () => Promise<void>;
let plant2 = '';
let owner: SessionUser;
afterAll(async () => {
  await updatePlant(app, owner, plant2, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end()]);
});
const marker = `pf${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const u = {} as Record<string, SessionUser>;
let plant1 = '';
let componentId = '';
let scene: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
const DATE = '2026-06-01';
const refused = async (p: Promise<unknown>) => {
  try {
    const r = (await p) as { ok?: boolean } | null;
    return r === null || r?.ok === false;
  } catch {
    return true;
  }
};
const asOwner = <T>(plant: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plant]);
    return fn(tx);
  });
const level = async (plant: string) =>
  Number(
    (
      await migrator.query<{ n: string }>(
        `select coalesce(sum(qty_base), 0)::text as n from stock_movement where component_id = $1 and plant_id = $2`,
        [componentId, plant],
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plant1 = v.plantId;
  u.owner = v.owner;
  for (const r of ['app_admin', 'office_sales', 'plant_manager', 'driver'] as const) u[r] = v.session(r);
  // the shared scene is built while this plant is the only active one, then the second plant opens
  master = await orderMaster(app, owner.id, marker);
  scene = await asOwner(plant1, () => deliveryScene(app, owner.id, marker, DATE));
  const p2 = await createPlant(app, owner, { code: letters(6), name: `PF2 ${marker}` });
  if (!p2.ok) throw new Error(p2.error);
  plant2 = p2.value.id;
  // a plant manager of the second plant
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, 'plant_manager', 'fr', 'active', true, now(), $4)`,
    [id, `${marker} pm2`, `${marker}-pm2-${id}@belgobeton.test`, plant2],
  );
  u.pm2 = { ...v.session('plant_manager'), id, name: `${marker} pm2`, email: `${id}@belgobeton.test` };
  componentId = (await migrator.query<{ id: string }>(`select id from component order by code limit 1`))
    .rows[0]!.id;
});

describe('transfers between the plants (§16.5)', () => {
  let id = '';
  it('the sending plant manager sends: the origin loses the quantity, the receiving plant is told', async () => {
    const before = await level(plant1);
    const r = await sendTransfer(app, u.plant_manager!, {
      kind: 'material',
      fromPlant: plant1,
      toPlant: plant2,
      componentId,
      qty: 1000,
      date: DATE,
    });
    if (!r.ok) throw new Error(r.error);
    id = r.value.id;
    expect(await level(plant1)).toBe(before - 1000);
    expect((await listMyNotifications(app, u.pm2!, 20)).some((n) => n.kind === 'transfer')).toBe(true);
  });
  it('only the sender sends and hands over, only the destination receives, and only once in order', async () => {
    expect(
      await refused(
        sendTransfer(app, u.pm2!, {
          kind: 'material',
          fromPlant: plant1,
          toPlant: plant2,
          componentId,
          qty: 5,
          date: DATE,
        }),
      ),
    ).toBe(true);
    expect(
      await refused(
        sendTransfer(app, u.office_sales!, {
          kind: 'material',
          fromPlant: plant1,
          toPlant: plant2,
          componentId,
          qty: 5,
          date: DATE,
        }),
      ),
    ).toBe(true);
    expect(
      await refused(
        sendTransfer(app, u.owner!, {
          kind: 'material',
          fromPlant: plant1,
          toPlant: plant1,
          componentId,
          qty: 5,
          date: DATE,
        }),
      ),
    ).toBe(true);
    expect(
      await refused(
        sendTransfer(app, u.owner!, {
          kind: 'fuel',
          fromPlant: plant1,
          toPlant: plant2,
          componentId,
          qty: 5,
          date: DATE,
        }),
      ),
    ).toBe(true);
    expect(await refused(receiveTransfer(app, u.pm2!, { id, qty: 900, date: DATE }))).toBe(true); // not in transit yet
    expect(await refused(pickUpTransfer(app, u.pm2!, id))).toBe(true);
    expect((await pickUpTransfer(app, u.plant_manager!, id, 'carrier: T3')).ok).toBe(true);
    expect(await refused(pickUpTransfer(app, u.plant_manager!, id))).toBe(true);
    expect(await refused(receiveTransfer(app, u.plant_manager!, { id, qty: 900, date: DATE }))).toBe(true);
    expect(await refused(receiveTransfer(app, u.pm2!, { id, qty: 2000, date: DATE }))).toBe(true);
  });
  it('the destination records what arrived: the variance is kept, the owner is told, the destination gains what was received', async () => {
    const before = await level(plant2);
    const r = await receiveTransfer(app, u.pm2!, { id, qty: 940, date: DATE });
    expect(r).toMatchObject({ ok: true, value: { variance: 60 } });
    expect(await level(plant2)).toBe(before + 940);
    const t = (await listTransfers(app, u.owner!)).find((x) => x.id === id)!;
    expect(t).toMatchObject({
      status: 'received',
      qty: 1000,
      receivedQty: 940,
      variance: 60,
      sentByRole: 'plant_manager',
      receivedByRole: 'plant_manager',
    });
    expect(
      (await listMyNotifications(app, u.owner!, 60)).some(
        (n) => n.kind === 'transfer' && n.params.step === 'variance',
      ),
    ).toBe(true);
    expect(await refused(receiveTransfer(app, u.pm2!, { id, qty: 940, date: DATE }))).toBe(true);
  });
  it('fuel moves as a record without a stock effect, and a plant manager reads only the transfers of their own plant', async () => {
    const f = await sendTransfer(app, u.owner!, {
      kind: 'fuel',
      fromPlant: plant2,
      toPlant: plant1,
      qty: 200,
      date: DATE,
    });
    expect(f.ok).toBe(true);
    expect((await listTransfers(app, u.plant_manager!)).some((x) => x.id === id)).toBe(true);
    await expect(listTransfers(app, u.office_sales!)).rejects.toThrow();
  });
});

describe('one timeline per order (§16.8)', () => {
  it('lists the steps in order with the device time and the server time of each, and hides other plants', async () => {
    const o = await asOwner(plant1, (tx) =>
      insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DATE),
    );
    const tripId = await asOwner(plant1, async (tx) => {
      const t = await tx.query<{ id: string }>(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by, plant_id)
         values (gen_random_uuid(), gen_random_uuid(), $4, $1, 1, $2, 8000, 420, 430, 455, 485, 520, $3, $5) returning id`,
        [o.id, scene.truckId, owner.id, DATE, plant1],
      );
      const d = await insertDelivery(
        tx,
        owner.id,
        { orderId: o.id, truckId: scene.truckId, recetteId: scene.recetteId },
        8000,
      );
      // the taps were made offline at 08:00 and 08:10 and reached the server later
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', '2026-06-01T08:00:00Z', $2, $3)`,
        [t.rows[0]!.id, d.id, owner.id],
      );
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, created_by) values (gen_random_uuid(), $1, 'departed', '2026-06-01T08:10:00Z', $2)`,
        [t.rows[0]!.id, owner.id],
      );
      return t.rows[0]!.id;
    });
    expect(tripId).toBeTruthy();
    const tl = await getOrderTimeline(app, u.plant_manager!, o.id);
    expect(tl.map((e) => e.step)).toEqual(
      expect.arrayContaining(['recorded', 'planned', 'mixed', 'left', 'bl']),
    );
    const mixed = tl.find((e) => e.step === 'mixed')!;
    expect(mixed.at).toBe('2026-06-01T08:00:00.000Z');
    expect(new Date(mixed.syncedAt).getTime()).toBeGreaterThan(new Date(mixed.at).getTime());
    expect(mixed.actorName).toBeTruthy();
    const steps = tl.map((e) => e.step);
    expect(steps.indexOf('mixed')).toBeLessThan(steps.indexOf('left'));
    expect(tl.some((e) => e.step === 'invoiced' || e.step === 'collected')).toBe(false);
    // another plant's manager sees nothing; a driver has no access
    expect(await getOrderTimeline(app, u.pm2!, o.id)).toEqual([]);
    await expect(getOrderTimeline(app, u.driver!, o.id)).rejects.toThrow();
  });
});

describe('the day close per plant (§16.9)', () => {
  it('a day with an unconfirmed load is blocked and goes to the owner, who can close it knowingly with a note', async () => {
    const status = await getDayCloseStatus(app, u.plant_manager!, { plantId: plant1, date: DATE });
    if (!status.ok) throw new Error(status.error);
    expect(status.value.find((i) => i.kind === 'unconfirmed_load')).toMatchObject({ blocking: true });
    expect(status.value.find((i) => i.kind === 'unconfirmed_load')!.n).toBeGreaterThanOrEqual(1);
    expect(await closeDay(app, u.plant_manager!, { plantId: plant1, date: DATE })).toMatchObject({
      ok: true,
      value: 'blocked',
    });
    expect((await listMyNotifications(app, u.owner!, 80)).some((n) => n.kind === 'day_close_blocking')).toBe(
      true,
    );
    // the plant manager cannot force, nor can the owner without a note, nor can another plant's manager close it
    expect(
      await closeDay(app, u.plant_manager!, { plantId: plant1, date: DATE, force: true, note: 'x' }),
    ).toMatchObject({ value: 'blocked' });
    expect(await closeDay(app, u.owner!, { plantId: plant1, date: DATE, force: true })).toMatchObject({
      value: 'blocked',
    });
    expect(await refused(closeDay(app, u.pm2!, { plantId: plant1, date: DATE }))).toBe(true);
    expect(
      await closeDay(app, u.app_admin!, {
        plantId: plant1,
        date: DATE,
        force: true,
        note: 'BLs are on the way',
      }),
    ).toMatchObject({ value: 'closed' });
    expect(await closeDay(app, u.owner!, { plantId: plant1, date: DATE })).toMatchObject({
      value: 'already',
    });
    const closes = await listDayCloses(app, u.plant_manager!, DATE, DATE);
    expect(closes).toEqual([
      expect.objectContaining({ plantId: plant1, date: DATE, forced: true, note: 'BLs are on the way' }),
    ]);
  });
  it('a quiet day closes by the plant manager', async () => {
    expect(await closeDay(app, u.pm2!, { plantId: plant2, date: '2026-06-02' })).toMatchObject({
      ok: true,
      value: 'closed',
    });
    expect(await refused(closeDay(app, u.office_sales!, { plantId: plant2, date: '2026-06-03' }))).toBe(true);
  });
});

describe('three older reads are scoped to the plant of a plant manager (Batch A gap)', () => {
  it('the order chain, the delivery note and the dispatch board give a plant manager their own plant only', async () => {
    const o = await asOwner(plant1, (tx) =>
      insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, DATE),
    );
    const d = await asOwner(plant1, async (tx) => {
      await tx.query(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by, plant_id)
         values (gen_random_uuid(), gen_random_uuid(), '2026-06-04', $1, 1, $2, 8000, 420, 430, 455, 485, 520, $3, $4)`,
        [o.id, scene.truckId, owner.id, plant1],
      );
      return insertDelivery(
        tx,
        owner.id,
        { orderId: o.id, truckId: scene.truckId, recetteId: scene.recetteId },
        2000,
      );
    });
    const seen = (who: SessionUser) =>
      inRequest(app, who, async (tx) => ({
        chain: (await tx.query(`select 1 from public.order_chain() where code = $1`, [o.code])).rowCount,
        note: (await tx.query(`select 1 from public.delivery_note($1)`, [d.id])).rowCount,
        board: (await tx.query(`select 1 from public.dispatch_office('2026-06-04') where volume_l = 8000`))
          .rowCount,
      }));
    expect(await seen(u.plant_manager!)).toEqual({ chain: 1, note: 1, board: 1 });
    expect(await seen(u.pm2!)).toEqual({ chain: 0, note: 0, board: 0 });
    // the owner's chain is capped at 300 recent orders, so only the other two reads are compared
    expect(await seen(u.owner!)).toMatchObject({ note: 1, board: 1 });
  });
});

describe('the fuel tank of each plant moves with the fuel transfers (C3)', () => {
  const tank = async (plant: string) =>
    (await getFuelTankLevels(app, u.owner!)).find((t) => t.plantId === plant)!;
  it('sending takes the litres out of the sender, receiving adds what arrived; the difference stays the variance', async () => {
    const a0 = await tank(plant1);
    const b0 = await tank(plant2);
    const set = await setFuelTankOpening(app, u.owner!, {
      plantId: plant1,
      litres: 5000,
      asOf: '2000-01-01',
    }).catch(() => null);
    const a1 = set?.ok ? await tank(plant1) : a0;
    const sent = await sendTransfer(app, u.owner!, {
      kind: 'fuel',
      fromPlant: plant1,
      toPlant: plant2,
      componentId: null,
      qty: 1000,
      date: DATE,
      note: null,
    });
    if (!sent.ok) throw new Error(sent.error);
    const a2 = await tank(plant1);
    expect(a2.levelL).toBe(a1.levelL - 1000);
    expect((await tank(plant2)).inTransitL).toBe(b0.inTransitL + 1000);
    expect((await tank(plant2)).levelL).toBe(b0.levelL);
    await pickUpTransfer(app, u.owner!, sent.value.id);
    const r = await receiveTransfer(app, u.owner!, { id: sent.value.id, qty: 980, date: DATE });
    expect(r.ok).toBe(true);
    const b1 = await tank(plant2);
    expect(b1.levelL).toBe(b0.levelL + 980);
    expect(b1.inTransitL).toBe(b0.inTransitL);
  });
  it('the opening is set once; other roles cannot set it; no price is returned', async () => {
    expect(
      await setFuelTankOpening(app, u.owner!, { plantId: plant2, litres: 100, asOf: '2000-01-01' }).catch(
        () => null,
      ),
    ).not.toBeNull();
    expect(
      await refused(setFuelTankOpening(app, u.owner!, { plantId: plant2, litres: 200, asOf: '2000-01-01' })),
    ).toBe(true);
    expect(
      await refused(
        setFuelTankOpening(app, u.office_sales!, { plantId: plant1, litres: 1, asOf: '2000-01-01' }),
      ),
    ).toBe(true);
    expect(JSON.stringify(await getFuelTankLevels(app, u.owner!))).not.toMatch(
      /price|centimes|total|amount/i,
    );
  });
});
