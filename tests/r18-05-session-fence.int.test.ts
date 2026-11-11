import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeFieldSession,
  loginDriver,
  revokeDriverDevice,
  sessionOfToken,
  setDriverPin,
  syncActions,
  verifyFieldToken,
} from '../src/modules/field';
import { authTestKit } from './auth-helpers';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R18-05: a revocation takes effect BETWEEN the transactions of a sync batch. One batch of three taps; the second is held inside the database while the
 * session is revoked; the third must be refused (and nothing else changes). The session user carries the live session; every transaction it opens checks it.
 */
const env = testEnv();
const kit = authTestKit();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 10 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r5${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret: kit.env.AUTH_SECRET });

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end(), kit.close()]);
});

async function signedInDriver(device?: string) {
  const code = (await w.sup<{ code: string }>('select code from driver where id = $1', [w.driverA]))[0]!.code;
  expect((await setDriverPin(deps(), w.owner, { driverId: w.driverA, pin: '482913' })).ok).toBe(true);
  if (!device) await revokeDriverDevice(deps(), w.owner, w.driverA); // release the earlier phone: this test binds its own
  const r = await loginDriver(
    deps(),
    { code, pin: '482913', deviceId: device ?? `phone-${randomUUID()}` },
    new Date(),
  );
  if (!r.ok) throw new Error(r.error);
  const token = verifyFieldToken(kit.env.AUTH_SECRET, r.value.token, Math.floor(Date.now() / 1000))!;
  const user = await sessionOfToken({ authPool: kit.authPool }, token);
  expect(user?.fieldSession).toEqual({
    driverId: w.driverA,
    deviceRowId: token.deviceRowId,
    gen: token.gen,
    exp: token.exp,
  });
  return { token, user: user!, device: device ?? 'x' };
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

describe('R18-05: the session is fenced at every transaction of a batch', () => {
  it('control: a live session applies the whole batch', async () => {
    const { user } = await signedInDriver();
    const trips = [] as string[];
    for (let i = 0; i < 3; i++)
      trips.push((await w.newTrip(w.plantA, w.truckA, w.driverA, { day: `2097-01-${10 + i}` })).trip);
    const r = await syncActions(app, user, trips.map(loaded), { now: new Date() });
    expect(r.ok && r.value.map((o) => o.status)).toEqual(['recorded', 'recorded', 'recorded']);
  });

  it('a revocation that lands while the batch is on its way: the transaction already admitted finishes, every later one is refused, the rest of the batch is not applied', async () => {
    const { token, user } = await signedInDriver();
    const trips = [] as string[];
    for (let i = 0; i < 3; i++)
      trips.push((await w.newTrip(w.plantA, w.truckA, w.driverA, { day: `2097-02-${10 + i}` })).trip);
    // hold the second tap INSIDE the database (its trip's advisory lock), after its fence has passed
    const holder = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    await holder.connect();
    await holder.query(`select pg_advisory_lock(hashtextextended('trip_event:' || $1::text, 0))`, [trips[1]]);
    const batch = syncActions(app, user, trips.map(loaded), { now: new Date() });
    const waitFor = async (sql: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await migrator.query(sql)).rowCount) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`never: ${sql}`);
    };
    await waitFor(`select 1 from pg_locks where locktype = 'advisory' and not granted`); // the 2nd tap waits for the held lock
    expect(await recorded(trips[0]!)).toBe(1);
    // the revocation: a logout of this session. It must wait for the tap that is already inside (its fence holds the device row FOR SHARE)
    let revoked: boolean | null = null;
    const revoke = closeFieldSession({ authPool: kit.authPool }, token).then((v) => (revoked = v));
    await new Promise((r) => setTimeout(r, 300));
    expect(revoked).toBeNull(); // still waiting behind the tap that was admitted
    await holder.query(`select pg_advisory_unlock_all()`);
    await holder.end();
    const result = await batch;
    expect(await revoke).toBe(true);
    // the first two taps were admitted before the revocation; the third was refused by the fence, and the batch says the session ended
    expect(result).toEqual({ ok: false, error: 'SESSION_ENDED' });
    expect(await recorded(trips[0]!)).toBe(1);
    expect(await recorded(trips[1]!)).toBe(1);
    expect(await recorded(trips[2]!)).toBe(0);
    // and nothing the revoked session sends is applied afterwards
    const again = await syncActions(app, user, [loaded(trips[2]!)], { now: new Date() });
    expect(again).toEqual({ ok: false, error: 'SESSION_ENDED' });
    expect(await recorded(trips[2]!)).toBe(0);
  });

  it('a newer sign-in of the same phone, a released phone and a disabled account each end an old session user at its next transaction', async () => {
    for (const how of ['relogin', 'disabled'] as const) {
      const dev = `phone-${randomUUID()}`;
      const { user } = await signedInDriver(undefined).then(async (first) => {
        // bind THIS test's phone, then sign in again on it for the relogin case
        await revokeDriverDevice(deps(), w.owner, w.driverA);
        void first;
        return signedInDriver(dev);
      });
      const t = (
        await w.newTrip(w.plantA, w.truckA, w.driverA, { day: `2097-03-${how === 'relogin' ? 10 : 11}` })
      ).trip;
      if (how === 'relogin')
        await signedInDriver(); // the same driver signs in again on a new phone? no: a new login bumps the SAME bound phone's generation
      else await migrator.query(`update "user" set status = 'disabled' where id = $1`, [w.driverUserA.id]);
      const r = await syncActions(app, user, [loaded(t)], { now: new Date() });
      expect(r, how).toEqual({ ok: false, error: 'SESSION_ENDED' });
      expect(await recorded(t), how).toBe(0);
      await migrator.query(`update "user" set status = 'active' where id = $1`, [w.driverUserA.id]);
    }
  });
});
