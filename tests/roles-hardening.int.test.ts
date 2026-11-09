import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, updatePlant } from '../src/modules/master-data';
import { listTrips } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { can, rolesWith } from '../src/modules/platform-security/domain/permissions';
import { createManagedUser } from '../src/modules/platform-security/service/user-admin';
import { authTestKit } from './auth-helpers';
import { testEnv } from './db-env';
import { deliveryScene, insertDelivery, insertOrder, orderMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// T8-B (decision of the owner): `partner` and `support` never get accounts in V1; a missing or unknown role is denied by default; the
// tracking of a rotation (steps, started flag) is read by owner/app_admin and by the plant manager of THAT plant only.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const kit = authTestKit();
const marker = `rh${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const date = '2092-06-08';

let done: () => Promise<void>;
let owner: SessionUser, pmA: SessionUser, pmB: SessionUser, partner: SessionUser, support: SessionUser;
let appAdmin: SessionUser;
let plantA = '',
  plantB = '',
  trip = '';

const as = <T>(u: { id: string; role: string }, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  owner = v.owner;
  plantA = v.plantId;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  partner = v.session('partner') as unknown as SessionUser;
  support = v.session('support') as unknown as SessionUser;
  appAdmin = v.session('app_admin') as unknown as SessionUser;
  const master = await orderMaster(app, owner.id, `${marker}a`);
  const scene = await deliveryScene(app, owner.id, `${marker}a`, '2092-01-01');
  const b = await createPlant(app, owner, {
    code: `B${marker.slice(2, 7).toUpperCase().replace(/[0-9]/g, 'X')}`,
    name: `RH B ${marker}`,
  });
  if (!b.ok) throw new Error(b.error);
  plantB = b.value.id;
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, 'plant_manager', 'fr', 'active', true, now(), $4)`,
    [id, `${marker} pmB`, `${marker}-pmb-${id}@kayas.test`, plantB],
  );
  pmB = { id, name: `${marker} pmB`, role: 'plant_manager', locale: 'fr' } as unknown as SessionUser;
  const order = await withRlsContext(
    app,
    { userId: owner.id, role: 'owner', requestId: marker },
    async (tx) => {
      await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
      return insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, date);
    },
  );
  trip = randomUUID();
  await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
    await tx.query(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
       values ($1, $2, $3, $4, 1, $5, 4000, 420, 430, 460, 500, 530, $6)`,
      [trip, randomUUID(), date, order.id, scene.truckId, owner.id],
    );
  });
  const d = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantA]);
    const del = await insertDelivery(
      tx,
      owner.id,
      { orderId: order.id, truckId: scene.truckId, recetteId: scene.recetteId },
      1000,
    );
    return (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [del.blNo])).rows[0]!
      .id;
  });
  await withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query(
      `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now(), $2, $3)`,
      [trip, d, owner.id],
    ),
  );
});
afterAll(async () => {
  if (plantB) await updatePlant(app, owner, plantB, { status: 'archived' });
  await done();
  await Promise.all([app.end(), migrator.end(), kit.close()]);
});

describe('B1: partner and support never get accounts', () => {
  const deps = () => ({ auth: kit.auth, authPool: kit.authPool, appPool: app });
  it.each(['partner', 'support'] as const)('the admin service refuses to create a %s', async (role) => {
    await expect(
      createManagedUser(deps(), owner, {
        email: `${marker}-${role}@kayas.test`,
        name: 'X',
        role: role as never,
        locale: 'fr',
        password: kit.password,
      }),
    ).rejects.toThrow();
    const r = await migrator.query('select 1 from "user" where email = $1', [`${marker}-${role}@kayas.test`]);
    expect(r.rowCount).toBe(0);
  });
  it.each(['partner', 'support'])(
    'the database refuses a %s account from the application logins',
    async (role) => {
      await expect(kit.newUser(role as never)).rejects.toThrow();
      // not an insert, and not a promotion of an existing account either
      const u = await kit.newUser('office');
      await expect(
        kit.authPool.query(`update "user" set role = $2 where id = $1`, [u.id, role]),
      ).rejects.toThrow();
      const r = await migrator.query<{ role: string }>('select role from "user" where id = $1', [u.id]);
      expect(r.rows[0]!.role).toBe('office');
    },
  );
  it('the application login (belgobeton_app) cannot write accounts at all', async () => {
    await expect(app.query(`update "user" set role = 'partner' where id = $1`, [pmB.id])).rejects.toThrow();
  });
});

describe('B2: a missing or unknown role is denied', () => {
  it('can() grants nothing to an unknown or empty role', () => {
    for (const r of [undefined, null, '', 'nobody', 'PARTNER']) {
      expect(can(r as never, 'trips.read')).toBe(false);
      expect(can(r as never, 'users.manage')).toBe(false);
    }
  });
  it('no function of our schemas still tests a role with a bare "NOT IN" (NULL, not true, for a missing role)', async () => {
    const { rows } = await migrator.query<{ name: string; src: string }>(
      `select n.nspname || '.' || p.proname as name, p.prosrc as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'ctx', 'finance', 'audit') and p.prokind = 'f'`,
    );
    const bare = /(ctx\.actor_role\(\)|ctx\.role\(\)|\bv_role)\s+NOT\s+IN\s*\(/i;
    expect(rows.filter((r) => bare.test(r.src)).map((r) => r.name)).toEqual([]);
    expect(rows.length).toBeGreaterThan(100); // the scan really looked at the catalogue
  });
  it.each([
    ['set_trip_estimate', `select public.set_trip_estimate($1::uuid, null, 'loading', 10, 'x y z')`],
    [
      'log_dispatch_change',
      `select public.log_dispatch_change('reassign', $2::uuid, null, null, null, null, null, 'x y z')`,
    ],
  ])('%s refuses a known user with no role', async (_n, sql) => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [owner.id]);
      await expect(c.query(sql, [plantA, trip])).rejects.toThrow();
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });
  it('a role the database does not know is refused', async () => {
    await expect(
      withRlsContext(app, { userId: owner.id, role: 'root' as never, requestId: marker }, (tx) =>
        tx.query('select 1 from trip_event'),
      ),
    ).rejects.toThrow();
  });
});

describe('B3: trip_started is no oracle', () => {
  const started = (u: { id: string; role: string }, id: string) =>
    as(
      u,
      async (tx) => (await tx.query<{ s: boolean }>('select public.trip_started($1) s', [id])).rows[0]!.s,
    );
  it('owner, app_admin and the plant manager of the plant learn it', async () => {
    expect(await started(owner, trip)).toBe(true);
    expect(await started(appAdmin, trip)).toBe(true);
    expect(await started(pmA, trip)).toBe(true);
  });
  it('another plant, partner and support learn nothing', async () => {
    expect(await started(pmB, trip)).toBe(false);
    expect(await started(partner, trip)).toBe(false);
    expect(await started(support, trip)).toBe(false);
  });
  it('the cancellation guard still sees a started rotation whoever cancels', async () => {
    await expect(
      as(owner, (tx) =>
        tx.query(
          `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values (gen_random_uuid(), $1, 'test reason', $2)`,
          [trip, owner.id],
        ),
      ),
    ).rejects.toThrow(/started|cancel|column|violat/i);
  });
});

describe('B4: tracking is read by owner/app_admin and the plant manager of that plant only', () => {
  it('the permissions of the tracking screens list no partner and no support', () => {
    for (const p of ['trips.read', 'trips.track', 'dispatch.read', 'dispatch.write'] as const) {
      const roles = rolesWith(p) as readonly string[];
      expect(roles, p).not.toContain('partner');
      expect(roles, p).not.toContain('support');
      expect(roles, p).toContain('owner');
      expect(roles, p).toContain('app_admin');
    }
  });
  it.each([
    ['owner', () => owner, 1],
    ['app_admin', () => appAdmin, 1],
    ['plant manager of the plant', () => pmA, 1],
    ['plant manager of ANOTHER plant', () => pmB, 0],
    ['partner', () => partner, 0],
    ['support', () => support, 0],
  ])('raw trip steps: %s sees %s', async (_w, who, n) => {
    const r = await as(who(), (tx) => tx.query('select 1 from trip_event where trip_id = $1', [trip]));
    expect(r.rowCount).toBe(n);
  });
  it('the board shows the steps to owner and the own plant manager, nothing to the others', async () => {
    for (const u of [owner, pmA]) {
      const r = await listTrips(app, u, date);
      expect(r.ok, u.role).toBe(true);
      if (r.ok) expect(r.value.find((t) => t.id === trip)?.events.loaded, u.role).toBeDefined();
    }
    const other = await listTrips(app, pmB, date);
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value.find((x) => x.id === trip)?.events.loaded).toBeUndefined();
    // partner and support have no tracking permission at all
    for (const u of [partner, support]) await expect(listTrips(app, u, date)).rejects.toThrow();
  });
});
