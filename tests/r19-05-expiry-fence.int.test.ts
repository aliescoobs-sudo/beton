import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loginDriver,
  revokeDriverDevice,
  sessionOfToken,
  setDriverPin,
  signFieldToken,
  syncActions,
  verifyFieldToken,
} from '../src/modules/field';
import { inRequest } from '../src/modules/platform-security';
import { authTestKit } from './auth-helpers';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R19-05: a request admitted just before its token expires must not write after the expiry, and an account change made while a batch is on its way is felt by
 * the next transaction. REAL signed tokens (the expiry is inside the signature), the real sync service, the real database fence. The taps are real rotations
 * of plant A. A transaction held INSIDE the database (a trip's advisory lock) lets time and account changes pass between two transactions of one batch.
 */
const env = testEnv();
const kit = authTestKit();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 10 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r9${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret: kit.env.AUTH_SECRET });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end(), kit.close()]);
});

/** A real login, then the same session re-signed with a chosen expiry (the secret is the server's; the database knows the session by generation, not by expiry). */
async function admit(ttlSeconds: number) {
  const code = (await w.sup<{ code: string }>('select code from driver where id = $1', [w.driverA]))[0]!.code;
  expect((await setDriverPin(deps(), w.owner, { driverId: w.driverA, pin: '482913' })).ok).toBe(true);
  await revokeDriverDevice(deps(), w.owner, w.driverA);
  await w.sup(`update "user" set status = 'active' where id = $1`, [w.driverUserA.id]);
  await w.sup(`update driver set status = 'active' where id = $1`, [w.driverA]);
  const r = await loginDriver(deps(), { code, pin: '482913', deviceId: `phone-${randomUUID()}` }, new Date());
  if (!r.ok) throw new Error(r.error);
  const real = verifyFieldToken(kit.env.AUTH_SECRET, r.value.token, Math.floor(Date.now() / 1000))!;
  const raw = signFieldToken(kit.env.AUTH_SECRET, {
    ...real,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  const token = verifyFieldToken(kit.env.AUTH_SECRET, raw, Math.floor(Date.now() / 1000))!;
  const user = await sessionOfToken({ authPool: kit.authPool }, token);
  expect(user?.fieldSession?.exp).toBe(token.exp);
  return user!;
}
const loaded = (tripId: string) => ({
  kind: 'step' as const,
  key: `k-${randomUUID()}`,
  tripId,
  step: 'loaded',
  at: new Date().toISOString(),
});
const recorded = (trip: string) =>
  w.count(`select 1 from trip_event where trip_id = '${trip}' and step = 'loaded'`);
const trips = async (n: number, day: string) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push((await w.newTrip(w.plantA, w.truckA, w.driverA, { day: `${day}-${10 + i}` })).trip);
  return out;
};
const holdTrip = async (trip: string) => {
  const holder = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
  await holder.connect();
  await holder.query(`select pg_advisory_lock(hashtextextended('trip_event:' || $1::text, 0))`, [trip]);
  return holder;
};
const waitFor = async (sql: string) => {
  for (let i = 0; i < 100; i++) {
    if ((await migrator.query(sql)).rowCount) return;
    await sleep(50);
  }
  throw new Error(`never: ${sql}`);
};

describe('R19-05: the token expiry is enforced inside every transaction', () => {
  it('control: before its expiry the session applies a tap', async () => {
    const user = await admit(120);
    const [t] = await trips(1, '2097-04');
    const r = await syncActions(app, user, [loaded(t!)], { now: new Date() });
    expect(r.ok && r.value[0]?.status).toBe('recorded');
  });

  it('a request admitted before the expiry whose body arrives after it: nothing is written (the fence says the session ended)', async () => {
    const user = await admit(2);
    const [t] = await trips(1, '2097-05');
    await sleep(2600); // the client-controlled body is still on its way; the token expires meanwhile
    const r = await syncActions(app, user, [loaded(t!)], { now: new Date() });
    expect(r).toEqual({ ok: false, error: 'SESSION_ENDED' });
    expect(await recorded(t!)).toBe(0);
    // any other transaction of the same session user (a photo upload goes through the same door) is refused the same way
    await expect(inRequest(app, user, (tx) => tx.query('select 1'))).rejects.toMatchObject({
      code: '42501',
      message: 'field_session: ended',
    });
  });

  it('expiry crossed BETWEEN two transactions of one batch: the one admitted before finishes, the next is refused', async () => {
    const user = await admit(3);
    const ts = await trips(3, '2097-06');
    const holder = await holdTrip(ts[1]!);
    const batch = syncActions(app, user, ts.map(loaded), { now: new Date() });
    await waitFor(`select 1 from pg_locks where locktype = 'advisory' and not granted`); // the 2nd tap is inside the database
    expect(await recorded(ts[0]!)).toBe(1);
    await sleep(3200); // the token expires while the 2nd tap is held
    await holder.query('select pg_advisory_unlock_all()');
    await holder.end();
    expect(await batch).toEqual({ ok: false, error: 'SESSION_ENDED' });
    expect(await recorded(ts[0]!)).toBe(1);
    expect(await recorded(ts[1]!)).toBe(1); // admitted before the expiry
    expect(await recorded(ts[2]!)).toBe(0);
  });
});

describe('R19-05: an account change during an admitted batch is felt by the next transaction', () => {
  it.each([
    [
      'the linked user is disabled',
      `update "user" set status = 'disabled' where id = $1`,
      () => w.driverUserA.id,
    ],
    ['the driver is archived', `update driver set status = 'archived' where id = $1`, () => w.driverA],
  ])(
    '%s while a tap is inside the database: the change waits for it, then the rest of the batch is refused',
    async (_n, sql, target) => {
      const user = await admit(300);
      const ts = await trips(3, _n.includes('user') ? '2097-07' : '2097-08');
      const holder = await holdTrip(ts[1]!);
      const batch = syncActions(app, user, ts.map(loaded), { now: new Date() });
      await waitFor(`select 1 from pg_locks where locktype = 'advisory' and not granted`);
      let changed = false;
      const change = w.sup(sql, [target()]).then(() => (changed = true)); // the system actor: the driver table is FORCE row-level secured
      await sleep(400);
      expect(changed, 'the account change waits behind the admitted transaction').toBe(false);
      await holder.query('select pg_advisory_unlock_all()');
      await holder.end();
      expect(await batch).toEqual({ ok: false, error: 'SESSION_ENDED' });
      await change;
      expect(await recorded(ts[0]!)).toBe(1);
      expect(await recorded(ts[1]!)).toBe(1);
      expect(await recorded(ts[2]!)).toBe(0);
    },
  );
});
