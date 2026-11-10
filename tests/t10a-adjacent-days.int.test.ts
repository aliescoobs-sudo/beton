import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { saveDispatch } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { deliveryScene, insertOrder, orderMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

/** R15B-05: a truck's or a driver's rotation of the day before, running past midnight, double-books the first hour of the next day. */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const marker = `ad${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let owner: SessionUser;
let done: () => Promise<void>;
let plantId = '';
const as = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
    return fn(tx);
  });

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantId = v.plantId;
});
afterAll(async () => {
  await done();
  await Promise.all([app.end(), migrator.end()]);
});

async function scene(label: string, day: string) {
  const master = await orderMaster(app, owner.id, `${marker}${label}`);
  const sc = await deliveryScene(app, owner.id, `${marker}${label}`, '2093-01-01');
  const order = await as((tx) => insertOrder(tx, owner.id, { ...master, clientId: sc.clientId }, day));
  return { truck: sc.truckId, order: order.id };
}
async function nightTrip(truck: string, orderId: string, day: string) {
  // loads 23:20 and is back at 07:40 of the next day (the plan allows up to 48 h)
  await as((tx) =>
    tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, 4000, 1400, 1410, 1500, 1700, 1900, $6)`,
      [randomUUID(), randomUUID(), day, orderId, truck, owner.id],
    ),
  );
}

describe('R15B-05: adjacent days', () => {
  it('a rotation that ends after midnight is a TRUCK_OVERLAP for the next morning, and needs the audited override', async () => {
    const night = await scene('n1', '2093-05-09');
    const morning = await scene('m1', '2093-05-10');
    await nightTrip(night.truck, night.order, '2093-05-09');
    // the morning order is planned on the SAME truck (the scene trucks differ: move the morning rotation onto the night truck)
    const wanted = {
      date: '2093-05-10',
      rotations: [{ orderId: morning.order, truckId: night.truck, volumeL: 4000 }],
    };
    const refused = await saveDispatch(app, owner, wanted);
    expect(refused).toEqual({ ok: false, error: 'OVERLAP' });
    const accepted = await saveDispatch(app, owner, {
      ...wanted,
      overlapReason: 'Seul camion libre cette nuit',
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.overlapOverride).toBe(true);
      expect(accepted.value.conflicts.map((c) => c.kind)).toContain('TRUCK_OVERLAP');
    }
  });

  it('a different truck the next morning is not an overlap', async () => {
    const night = await scene('n2', '2093-06-09');
    const morning = await scene('m2', '2093-06-10');
    await nightTrip(night.truck, night.order, '2093-06-09');
    const other = await migrator.query<{ id: string }>(
      `select id from truck where id <> $1 and capacity_l >= 4000 and public.truck_available_on(id, '2093-06-10') order by code limit 1`,
      [night.truck],
    );
    const r = await saveDispatch(app, owner, {
      date: '2093-06-10',
      rotations: [{ orderId: morning.order, truckId: other.rows[0]!.id, volumeL: 4000 }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.overlapOverride).toBe(false);
  });

  it('saves of neighbouring days queue on the day locks (date order) and never deadlock', async () => {
    const a = await scene('a3', '2093-07-10');
    const b = await scene('b3', '2093-07-11');
    const c = await scene('c3', '2093-07-12');
    const save = (s: { order: string; truck: string }, date: string) =>
      saveDispatch(app, owner, { date, rotations: [{ orderId: s.order, truckId: s.truck, volumeL: 4000 }] });
    const results = await Promise.all([
      save(a, '2093-07-10'),
      save(b, '2093-07-11'),
      save(c, '2093-07-12'),
      save(b, '2093-07-11'),
    ]);
    for (const r of results)
      expect(r.ok || r.error === 'NOT_FOUND' || r.error === 'CONFLICT', JSON.stringify(r)).toBe(true);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(3);
  }, 30_000);
});
