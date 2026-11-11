import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { superuserUrl, TEST_DATABASE } from '../../scripts/db-bootstrap';
import { withRlsContext } from '../../src/lib/db/rls-context';
import { uuidv7 } from '../../src/lib/uuidv7';
import { businessDateOf, realClock } from '../../src/modules/clock';
import { createPlant, createTruck, updatePlant } from '../../src/modules/master-data';
import { SYSTEM_ACTOR_ID } from '../../src/modules/platform-security/auth/actors';
import type { SessionUser } from '../../src/modules/platform-security/auth/session-gate';
import { testEnv } from '../db-env';
import {
  deliveryScene,
  type DeliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
} from './ledger-fixtures';
import { v1Actors } from './v1-actors';

/**
 * R18: a world with plant A (the plant manager A's), plant B (another manager's), real trips in each and ONE trip with NO plant, real drivers
 * (with accounts), real loads and real stage rows, so a boundary test calls a door with TARGETS THAT EXIST (the review criticised random ids).
 * Everything is synthetic. `done()` archives the extra plant (other suites expect none).
 */
export type World = Awaited<ReturnType<typeof plantWorld>>;
export const DAY: string = businessDateOf(realClock.now());
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

export async function plantWorld(app: pg.Pool, migrator: pg.Pool, marker: string) {
  const env = testEnv();
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  const owner = v.owner;
  const plantA = v.plantId;
  const as = <T>(u: { id: string; role: string }, fn: (tx: pg.PoolClient) => Promise<T>) =>
    withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);
  const asOwnerIn = <T>(plant: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
    withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
      await tx.query(`select set_config('app.plant_id', $1, true)`, [plant]);
      return fn(tx);
    });
  async function sup<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    triggersOff: string[] = [],
  ): Promise<T[]> {
    const c = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
    await c.connect();
    try {
      await c.query(`select set_config('app.user_id', $1, false), set_config('app.role', 'system', false)`, [
        SYSTEM_ACTOR_ID,
      ]);
      for (const t of triggersOff) await c.query(`alter table ${t} disable trigger user`);
      try {
        return (await c.query<T>(sql, params)).rows;
      } finally {
        for (const t of triggersOff) await c.query(`alter table ${t} enable trigger user`);
      }
    } finally {
      await c.end();
    }
  }
  const master = await orderMaster(app, owner.id, `${marker}a`);
  const scene: DeliveryScene = await deliveryScene(app, owner.id, `${marker}a`, DAY);
  const b = await createPlant(app, owner, { code: letters(6), name: `WB ${marker}` });
  if (!b.ok) throw new Error(b.error);
  const plantB = b.value.id;
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
    } as unknown as SessionUser;
  }
  const pmA = v.session('plant_manager') as unknown as SessionUser;
  const pmB = await userRow('plant_manager', plantB);
  const driverUserA = await userRow('driver', null);
  const driverUserB = await userRow('driver', null);
  async function driverRow(name: string, user: SessionUser): Promise<string> {
    for (let i = 0; i < 40; i++) {
      try {
        return (
          await sup<{ id: string }>(
            `insert into driver (id, code, name, created_by, kind, user_id) values (gen_random_uuid(), $1, $2, $3, 'driver', $4) returning id`,
            [`CH-${1000 + Math.floor(Math.random() * 8999)}`, name, owner.id, user.id],
          )
        )[0]!.id;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    throw new Error('no free driver code');
  }
  const driverA = await driverRow(`Chauffeur A ${marker}`, driverUserA);
  const driverB = await driverRow(`Chauffeur B ${marker}`, driverUserB);
  const mkTruck = async (plant: string | null, tag: string) => {
    for (let i = 0; i < 30; i++) {
      const r = await createTruck(app, owner, {
        code: `${plant === null ? 'X' : 'T'}${100 + Math.floor(Math.random() * 890)}`,
        plate: `WD-${marker.slice(0, 8)}-${tag}${i}`,
        plantId: plant,
        kind: plant === null ? 'external' : 'mixer',
      });
      if (r.ok) return r.value.id;
    }
    throw new Error('no truck code');
  };
  const truckA = await mkTruck(plantA, 'a');
  const truckB = await mkTruck(plantB, 'b');
  const truckN = await mkTruck(null, 'n');
  let slot = 0;
  /** A real rotation (order + plan row) in a plant; `nullPlant` strips the plant from the plan and its order, as a legacy rotation has none. */
  async function newTrip(
    plant: string,
    truck: string,
    driver: string | null,
    opts: { nullPlant?: boolean; day?: string } = {},
  ): Promise<{ trip: string; order: string; orderCode: string }> {
    const day = opts.day ?? DAY;
    const loadMin = 300 + 20 * (slot++ % 40);
    const made = await asOwnerIn(plant, async (tx) => {
      const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, day);
      const id = randomUUID();
      await tx.query(
        `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                                unload_end_min, back_min, created_by)
         values ($1, $2, $3, $4, 1, $5, $6, 1000, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          randomUUID(),
          day,
          o.id,
          truck,
          driver,
          loadMin,
          loadMin + 10,
          loadMin + 40,
          loadMin + 80,
          loadMin + 110,
          owner.id,
        ],
      );
      return { trip: id, order: o.id, orderCode: o.code };
    });
    if (opts.nullPlant) {
      await sup(`update trip_plan set plant_id = null where id = $1`, [made.trip], ['trip_plan']);
      await sup(`update sales_order set plant_id = null where id = $1`, [made.order], ['sales_order']);
    }
    return made;
  }
  /** The plant's own load of a rotation (a delivery of its order on its truck). */
  const plantLoad = (plant: string, orderId: string, truck: string) =>
    asOwnerIn(plant, async (tx) => {
      const d = await insertDelivery(
        tx,
        owner.id,
        { orderId, truckId: truck, recetteId: scene.recetteId },
        1000,
      );
      return (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo])).rows[0]!
        .id;
    });
  const tap = (u: SessionUser, trip: string, step: string, vol: number | null = null, at = new Date()) =>
    as(
      u,
      async (tx) =>
        (
          await tx.query<{ r: string }>('select public.driver_report($1, $2, $3, $4, $5, $6) as r', [
            trip,
            step,
            at,
            `k-${randomUUID()}`,
            vol,
            null,
          ])
        ).rows[0]!.r,
    );
  /** The application login with a request that names a user but NO role (or the given one) — the raw SQL an attacker with the login can send. */
  async function raw<T>(
    ctx: { user: string | null; role: string | null },
    fn: (tx: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true), set_config('app.role', $2, true)`, [
        ctx.user ?? '',
        ctx.role ?? '',
      ]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  /** The error (code, message) a statement raises in its own transaction, or null when it ran. */
  async function failure(
    ctx: { user: string | null; role: string | null },
    sql: string,
    args: unknown[] = [],
  ): Promise<{ code?: string; message: string } | null> {
    try {
      await raw(ctx, async (tx) => {
        await tx.query(sql, args);
        throw new Error('__ran__');
      });
    } catch (e) {
      const err = e as { code?: string; message: string };
      if (err.message === '__ran__') return null;
      return { code: err.code, message: err.message };
    }
    return null;
  }
  const count = async (sql: string, p: unknown[] = []) =>
    Number((await sup<{ n: string }>(`select count(*)::text n from (${sql}) q`, p))[0]!.n);
  return {
    env,
    owner,
    appAdmin: v.session('app_admin') as unknown as SessionUser,
    accountant: v.session('accountant') as unknown as SessionUser,
    sales: v.session('office_sales') as unknown as SessionUser,
    purchases: v.session('office_purchases') as unknown as SessionUser,
    partner: v.session('partner') as unknown as SessionUser,
    support: v.session('support') as unknown as SessionUser,
    pmA,
    pmB,
    plantA,
    plantB,
    driverUserA,
    driverUserB,
    driverA,
    driverB,
    truckA,
    truckB,
    truckN,
    master,
    scene,
    as,
    asOwnerIn,
    sup,
    newTrip,
    plantLoad,
    tap,
    raw,
    failure,
    count,
    async done() {
      await updatePlant(app, owner, plantB, { status: 'archived' });
      await v.done();
    },
  };
}
