import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createDriver,
  getDispatchDay,
  listTruckDefaultDrivers,
  saveDispatch,
  setTruckDefaultDriver,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// integration I4.1: a default driver on each truck, proposed by dispatch; any other driver on a rotation needs a reason that is
// stored and audited, refused by the service and by the database. AC-INT-20 (DECISIONS 91, Ali).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `dd${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const DAY = '2026-06-02';
let scene: DeliveryScene;
let usual: string;
let other: string;
let archived: string;

const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

async function newTruck(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = `T${100 + Math.floor(Math.random() * 899)}`;
    try {
      return await inCtx(users.owner, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into truck (id, code, plate, capacity_l) values (gen_random_uuid(), $1, $2, 8000) returning id`,
          [code, `${code}-${marker.slice(0, 8)}-${i}`],
        );
        return r.rows[0]?.id as string;
      });
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  throw new Error('no free truck code');
}
const newDriver = async (name: string) => {
  const d = await createDriver(app, users.owner, { name: `${name} ${marker}` });
  if (!d.ok) throw new Error(d.error);
  return d.value.id;
};
const rotation = (truckId: string, driverId: string | null, overrideReason?: string | null) => ({
  orderId: scene.orderId,
  truckId,
  driverId,
  volumeL: 1000,
  ...(overrideReason === undefined ? {} : { overrideReason }),
});
const reasonsOf = (truckId: string) =>
  inCtx(users.owner, (tx) =>
    tx.query<{ driver_id: string | null; driver_override_reason: string | null }>(
      `select p.driver_id, p.driver_override_reason from trip_plan p
        where p.truck_id = $1 and not exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id)`,
      [truckId],
    ),
  ).then((r) => r.rows);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  scene = await deliveryScene(app, users.owner.id, marker);
  usual = await newDriver('Usual');
  other = await newDriver('Other');
  archived = await newDriver('Archived');
});

describe('the default driver of a truck (AC-INT-20)', () => {
  it('owner and partner set it; plant, office and support cannot', async () => {
    const truck = await newTruck();
    for (const role of ['plant', 'office', 'support'] as const)
      await expect(
        setTruckDefaultDriver(app, users[role], { truckId: truck, driverId: usual }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setTruckDefaultDriver(app, users.partner, { truckId: truck, driverId: usual })).toEqual({
      ok: true,
      value: true,
    });
    const listed = await listTruckDefaultDrivers(app, users.plant);
    expect(listed.find((k) => k.truckId === truck)?.driverId).toBe(usual);
    expect(await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: null })).toMatchObject({
      ok: true,
    });
  });

  it('refuses an archived driver and a driver that does not exist, in the database', async () => {
    const truck = await newTruck();
    await inCtx(users.owner, (tx) =>
      tx.query(`update driver set status = 'archived' where id = $1`, [archived]),
    );
    expect(await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: archived })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: randomUUID() })).toEqual(
      { ok: false, error: 'INVALID' },
    );
    expect(await setTruckDefaultDriver(app, users.owner, { truckId: randomUUID(), driverId: usual })).toEqual(
      { ok: false, error: 'NOT_FOUND' },
    );
  });

  it('the change is audited on the truck', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from audit_event where table_name = 'truck' and action = 'update' and row_id = $1::text`,
        [truck],
      ),
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('dispatch reads it on the truck of the day', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    const day = await getDispatchDay(app, users.plant, DAY);
    if (!day.ok) throw new Error('day');
    expect(day.value.trucks.find((k) => k.id === truck)?.defaultDriverId).toBe(usual);
  });
});

describe('overriding it on a rotation (AC-INT-20)', () => {
  it('the default driver needs no reason; the rotation stores none', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    const saved = await saveDispatch(app, users.plant, { date: DAY, rotations: [rotation(truck, usual)] });
    expect(saved.ok).toBe(true);
    expect(await reasonsOf(truck)).toEqual([{ driver_id: usual, driver_override_reason: null }]);
  });

  it('another driver, or none, is refused without a reason and kept with one, stored with the rotation', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    for (const driver of [other, null]) {
      for (const reason of [undefined, null, '   ']) {
        expect(
          await saveDispatch(app, users.plant, { date: DAY, rotations: [rotation(truck, driver, reason)] }),
        ).toEqual({ ok: false, error: reason === '   ' ? 'INVALID' : 'OVERRIDE_REASON' });
      }
    }
    const saved = await saveDispatch(app, users.plant, {
      date: DAY,
      rotations: [rotation(truck, other, ' Usual   is sick ')],
    });
    expect(saved.ok).toBe(true);
    expect(await reasonsOf(truck)).toEqual([{ driver_id: other, driver_override_reason: 'Usual is sick' }]);
  });

  it('the override is audited: the insert of the rotation carries the reason', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    await saveDispatch(app, users.partner, {
      date: DAY,
      rotations: [rotation(truck, other, `swap ${marker}`)],
    });
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from audit_event
          where table_name = 'trip_plan' and action = 'insert' and actor_user_id = $1 and after::text like $2`,
        [users.partner.id, `%swap ${marker}%`],
      ),
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('a truck without a default has nothing to override: any driver, no reason; a reason there is refused', async () => {
    const truck = await newTruck();
    expect(
      (await saveDispatch(app, users.plant, { date: DAY, rotations: [rotation(truck, other)] })).ok,
    ).toBe(true);
    // the service drops a reason that is not needed, so the rotation stays clean
    expect((await reasonsOf(truck))[0]?.driver_override_reason).toBeNull();
  });

  it('the database refuses what the service would not send: no reason on an override, a reason on the default', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    const insert = (driver: string | null, reason: string | null) =>
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min,
                                  depart_min, arrive_min, unload_end_min, back_min, created_by, driver_override_reason)
           values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, $4, 1000, 420, 430, 455, 485, 520, $5, $6)`,
          [DAY, scene.orderId, truck, driver, users.plant.id, reason],
        ),
      );
    await expect(insert(other, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(usual, 'because')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(other, 'because')).resolves.toBeDefined();
  });

  it('a later change of default never rewrites a saved rotation', async () => {
    const truck = await newTruck();
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: usual });
    await saveDispatch(app, users.plant, { date: DAY, rotations: [rotation(truck, other, 'planned swap')] });
    await setTruckDefaultDriver(app, users.owner, { truckId: truck, driverId: other });
    expect(await reasonsOf(truck)).toEqual([{ driver_id: other, driver_override_reason: 'planned swap' }]);
  });
});
