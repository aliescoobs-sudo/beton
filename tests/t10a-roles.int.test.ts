import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { isLoginRole } from '../src/modules/platform-security/domain/login-roles';
import { assertNoUsableReservedAccounts } from '../src/modules/platform-security/service/reserved-admission';
import { setUserStatus } from '../src/modules/platform-security/service/user-admin';
import { authTestKit } from './auth-helpers';
import { testEnv } from './db-env';
import { deliveryScene, insertOrder, orderMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

/**
 * T10a, R17-03 (reserved roles are not usable, also for accounts that already exist) and R17-04 (named NULL-role doors: survey, timeline,
 * change log, cancellation stage). The generic sweep is tests/definer-catalogue.int.test.ts.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const kit = authTestKit();
const marker = `tr${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let owner: SessionUser, pmA: SessionUser, office: SessionUser;
let plantId = '';
let done: () => Promise<void>;
let v1: Awaited<ReturnType<typeof v1Actors>>;

const as = <T>(u: { id: string; role: string }, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.id, role: u.role as never, requestId: marker }, fn);
const deps = () => ({ auth: kit.auth, authPool: kit.authPool, appPool: app });

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  v1 = v;
  done = v.done;
  plantId = v.plantId;
  owner = v.owner;
  pmA = v.session('plant_manager') as unknown as SessionUser;
  office = v.session('office_sales') as unknown as SessionUser;
});
afterAll(async () => {
  await done();
  await Promise.all([app.end(), kit.close()]);
});

describe('R17-03: a reserved role (partner, support), an unknown or a missing role is not a login role', () => {
  it('the allowlist', () => {
    for (const r of ['partner', 'support', '', 'bogus', null, undefined, 42])
      expect(isLoginRole(r)).toBe(false);
    for (const r of ['owner', 'app_admin', 'plant_manager', 'office_sales', 'driver'])
      expect(isLoginRole(r)).toBe(true);
  });

  it('an EXISTING account whose role is reserved: its live session is no session, and a new login gets none', async () => {
    const u = await kit.enrolledUser('office');
    const cookie = u.cookie;
    expect((await resolveAuthState(kit.auth, new Headers({ cookie }))).kind).toBe('authenticated');
    // a pre-existing reserved-role account (made by hand, as an old installation could hold): migrator only
    await kit.migrator.query(`update "user" set role = 'partner' where id = $1`, [u.id]);
    expect((await resolveAuthState(kit.auth, new Headers({ cookie }))).kind).toBe('anonymous');
    // a new sign-in: the session hook refuses it, so no cookie is issued
    const res = await kit.call('/sign-in/email', { email: u.email, password: kit.password });
    expect(kit.cookieOf(res)).toBe('');
    await kit.migrator.query(`update "user" set role = 'office' where id = $1`, [u.id]);
  });

  it('auth-login direct writes: no session row for a reserved account, no re-activation, no promotion', async () => {
    const u = await kit.newUser('office');
    await kit.migrator.query(`update "user" set role = 'support', status = 'disabled' where id = $1`, [u.id]);
    await expect(
      kit.authPool.query(
        `insert into "session" (id, "expiresAt", token, "updatedAt", "userId") values ($1, now() + interval '1 hour', $2, now(), $3)`,
        [randomUUID(), randomUUID(), u.id],
      ),
    ).rejects.toThrow(/no sessions in V1/);
    await expect(
      kit.authPool.query(`update "user" set status = 'active' where id = $1`, [u.id]),
    ).rejects.toThrow(/no accounts in V1/);
    const w = await kit.newUser('office');
    await expect(
      kit.authPool.query(`update "user" set role = 'partner' where id = $1`, [w.id]),
    ).rejects.toThrow();
    const r = await kit.migrator.query<{ status: string; role: string }>(
      'select status, role from "user" where id = $1',
      [u.id],
    );
    expect(r.rows[0]).toEqual({ status: 'disabled', role: 'support' });
  });

  it('the service refuses to re-enable a disabled reserved-role account; a V1 account is enabled as before', async () => {
    const u = await kit.newUser('office');
    await kit.migrator.query(`update "user" set role = 'partner', status = 'disabled' where id = $1`, [u.id]);
    await expect(setUserStatus(deps(), owner, u.id, 'active')).rejects.toThrow(/no V1 role/);
    const w = await kit.newUser('office');
    await setUserStatus(deps(), owner, w.id, 'disabled');
    await setUserStatus(deps(), owner, w.id, 'active');
    const r = await kit.migrator.query<{ status: string }>('select status from "user" where id = $1', [w.id]);
    expect(r.rows[0]!.status).toBe('active');
  });

  it('the admission check: active blocks (and says how many), disabled passes, sessions of reserved accounts are revoked; start and seed use the same count', async () => {
    const c = await kit.migrator.connect();
    try {
      await c.query('begin');
      // the shared test database holds reserved-role fixtures of other files: the scenario starts from none
      await c.query(`update "user" set status = 'disabled' where role in ('partner', 'support')`);
      await c.query('select public.admit_no_reserved_accounts()'); // none usable: passes
      // an active reserved account with a live session: blocks; the session is revoked in the same call
      const a = uuidv7(realClock.now());
      await c.query(
        `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
         values ($1, 'R', $2, true, 'partner', 'fr', 'active', true, now())`,
        [a, `${marker}-adm-${a}@kayas.test`],
      );
      await c.query(
        `insert into "session" (id, "expiresAt", token, "updatedAt", "userId") values ($1, now() + interval '1 hour', $2, now(), $3)`,
        [randomUUID(), randomUUID(), a],
      );
      await c.query(`savepoint s`);
      await expect(c.query('select public.admit_no_reserved_accounts()')).rejects.toThrow(/1 usable account/);
      await c.query(`rollback to savepoint s`);
      // R18-03: the check no longer deletes (a delete followed by a raise was rolled back with it); revoke_reserved_sessions() is the cleanup, called first
      expect(
        await c.query('select public.revoke_reserved_sessions() as n').then((r) => Number(r.rows[0].n)),
      ).toBeGreaterThanOrEqual(1);
      // disabled, with a live session already revoked: passes, and the session is gone
      await c.query(`update "user" set status = 'disabled' where id = $1`, [a]);
      await c.query('select public.admit_no_reserved_accounts()');
      const left = await c.query(`select 1 from "session" where "userId" = $1`, [a]);
      expect(left.rowCount).toBe(0);
      // the process-side check counts the same
      expect(
        await c.query('select public.usable_reserved_role_accounts() as n').then((r) => Number(r.rows[0].n)),
      ).toBe(0);
    } finally {
      await c.query('rollback');
      c.release();
    }
    // outside the scenario the shared database does hold usable reserved fixtures: the process check reports them
    await expect(assertNoUsableReservedAccounts(kit.migrator)).rejects.toThrow(/reserved role/);
  });
});

describe('R17-04: the named NULL-role doors', () => {
  async function openSurvey(audience: string): Promise<string> {
    const id = randomUUID();
    await withRlsContext(kit.migrator, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
      tx.query(
        `insert into survey (id, title, audience_role, status, questions, created_by) values ($1, $2, $3, 'open', '[{"id":"q1","kind":"yes_no","text":"?"}]'::jsonb, $4)`,
        [id, `S ${marker}`, audience, owner.id],
      ),
    );
    return id;
  }
  const ctxQuery = async (role: string | null, user: string | null, sql: string, args: unknown[]) => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [
        role ?? '',
        user ?? '',
      ]);
      try {
        return { ok: true as const, rows: (await c.query(sql, args)).rows };
      } catch (e) {
        return { ok: false as const, message: (e as Error).message };
      }
    } finally {
      await c.query('rollback');
      c.release();
    }
  };

  it('answer_survey: no role, empty role, the wrong audience are refused; the audience itself answers', async () => {
    const s = await openSurvey('plant_manager');
    const before = await kit.migrator.query(
      'select count(*)::int as n from survey_response where survey_id = $1',
      [s],
    );
    for (const [role, user] of [
      [null, pmA.id],
      ['', pmA.id],
      ['office_sales', office.id],
    ] as const) {
      const r = await ctxQuery(role, user, `select public.answer_survey($1, '{"q1": true}'::jsonb)`, [s]);
      expect(r.ok, `role=${String(role)}`).toBe(false);
    }
    const after = await kit.migrator.query(
      'select count(*)::int as n from survey_response where survey_id = $1',
      [s],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const ok = await ctxQuery(
      'plant_manager',
      pmA.id,
      `select public.answer_survey($1, '{"q1": true}'::jsonb)`,
      [s],
    );
    expect(ok.ok).toBe(true);
  });

  it('order_timeline: anonymous, an unknown role, an unset role and a REAL driver are refused for a REAL order; an allowlisted role is answered', async () => {
    // R18-02: the target exists (an order with a delivery date), and the driver is a real driver account (the old test used a random id and no driver)
    const master = await orderMaster(app, owner.id, `${marker}tl`);
    const scene = await deliveryScene(app, owner.id, `${marker}tl`, '2093-01-01');
    const order = await as(owner, async (tx) => {
      await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
      return insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, '2093-05-01');
    });
    const driverUser = v1.session('driver');
    expect(driverUser.role).toBe('driver');
    for (const [role, user] of [
      ['anonymous', '00000000-0000-7000-8000-000000000000'],
      ['bogus', pmA.id],
      [null, pmA.id],
      ['', pmA.id],
      ['driver', driverUser.id],
      ['client_portal', pmA.id],
    ] as const) {
      const r = await ctxQuery(role, user, `select * from public.order_timeline($1)`, [order.id]);
      expect(r.ok, `role=${String(role)}`).toBe(false);
    }
    const ok = await ctxQuery('owner', owner.id, `select * from public.order_timeline($1)`, [order.id]);
    expect(ok.ok).toBe(true);
  });

  it('log_dispatch_change: a forged change input (new rotation or resources of another plant, day or order) is refused', async () => {
    // two rotations of two different orders on one plant are enough: the second is not a "new version" of the first
    const master = await orderMaster(app, owner.id, `${marker}lg`);
    const scene = await deliveryScene(app, owner.id, `${marker}lg`, '2093-01-01');
    const mk = async (seq: number) =>
      as(owner, async (tx) => {
        await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
        const o = await insertOrder(tx, owner.id, { ...master, clientId: scene.clientId }, '2093-04-01');
        const id = randomUUID();
        await tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min, created_by)
           values ($1, $2, '2093-04-01', $3, $4, $5, 4000, 420, 430, 460, 500, 530, $6)`,
          [id, randomUUID(), o.id, seq, scene.truckId, owner.id],
        );
        return { id, truck_id: scene.truckId, driver_id: null as string | null };
      });
    const r = [await mk(1), await mk(2)];
    const [a, b] = r as [(typeof r)[number], (typeof r)[number]];
    const call = (args: unknown[]) =>
      ctxQuery('owner', owner.id, `select public.log_dispatch_change($1,$2,$3,$4,$5,$6,$7,$8)`, args);
    // an unknown kind, a "new" rotation that is another order, resources that are not those of the rotations: all refused
    expect((await call(['bogus', a.id, null, a.truck_id, null, a.driver_id, null, 'essai'])).ok).toBe(false);
    expect(
      (await call(['reassign', a.id, b.id, a.truck_id, b.truck_id, a.driver_id, b.driver_id, 'essai'])).ok,
    ).toBe(false);
    expect((await call(['postpone', a.id, null, randomUUID(), null, a.driver_id, null, 'essai'])).ok).toBe(
      false,
    );
    expect(
      (await call(['postpone', randomUUID(), null, a.truck_id, null, a.driver_id, null, 'essai'])).ok,
    ).toBe(false);
    // the honest postponement is accepted
    expect((await call(['postpone', a.id, null, a.truck_id, null, a.driver_id, null, 'essai'])).ok).toBe(
      true,
    );
  });

  it('cancellation_trip_stage: no actor, no answer; a plant manager gets NULL (no stage) for a rotation that is not his', async () => {
    const t = randomUUID();
    expect((await ctxQuery(null, pmA.id, `select public.cancellation_trip_stage($1)`, [t])).ok).toBe(false);
    const own = await ctxQuery('plant_manager', pmA.id, `select public.cancellation_trip_stage($1) as s`, [
      t,
    ]);
    expect(own.ok && own.rows[0].s).toBeNull();
  });
});
