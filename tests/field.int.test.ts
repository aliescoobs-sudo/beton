import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { listMyNotifications } from '../src/modules/platform-security';
import {
  createFieldAccount,
  createPumpJob,
  getDriverDay,
  getPumpDay,
  hashDeviceId,
  instructDriver,
  listEmergencies,
  listFieldAccounts,
  loginDriver,
  revokeDriverDevice,
  sessionOfToken,
  setDriverPin,
  syncActions,
  verifyFieldToken,
} from '../src/modules/field';
import { fieldCipherFrom } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, insertDelivery } from './helpers/ledger-fixtures';

// R4 (CP-PROD-PLAN): AC-PROD-20 to 26. The phone signs in with a PIN and one bound device; every door checks the caller's own
// driver; nothing it returns holds a price.
const kit = authTestKit();
const app = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 4 });
const marker = `fd${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const secret = kit.env.AUTH_SECRET;
const cipher = fieldCipherFrom(parseKeyring(kit.env.FIELD_ENCRYPTION_KEYS));
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret });
const today = new Date().toISOString().slice(0, 10);
let owner: SessionUser;
let office: SessionUser;
let scene: Awaited<ReturnType<typeof deliveryScene>>;
let n = 100 + Math.floor(Math.random() * 600);

afterAll(async () => {
  await app.end();
  await kit.close();
});

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, fn);

async function newDriver(kind: 'driver' | 'pump_operator' = 'driver') {
  const no = n++;
  const row = await asOwner((tx) =>
    tx.query<{ id: string; code: string }>(
      `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, $4) returning id, code`,
      [`CH-${no}`, `${marker} ${no}`, owner.id, kind],
    ),
  );
  const d = row.rows[0]!;
  const acct = await createFieldAccount(deps(), owner, d.id);
  if (!acct.ok) throw new Error(acct.error);
  return { ...d, userId: acct.value.userId };
}
const device = () => `phone-${randomUUID()}`;
const signIn = async (d: { code: string }, pin: string, deviceId: string) =>
  loginDriver(deps(), { code: d.code, pin, deviceId }, new Date());
async function sessionFor(d: { id: string; code: string }, pin = '482913') {
  const dev = device();
  expect((await setDriverPin(deps(), owner, { driverId: d.id, pin })).ok).toBe(true);
  const r = await signIn(d, pin, dev);
  if (!r.ok) throw new Error(r.error);
  const token = verifyFieldToken(secret, r.value.token, Math.floor(Date.now() / 1000))!;
  const user = await sessionOfToken({ authPool: kit.authPool }, token);
  if (!user) throw new Error('no session');
  return { user, dev, token };
}
/** A rotation of the scene's order planned for today with this driver; optionally the plant's load already recorded. */
async function tripFor(driverId: string, loaded: boolean) {
  const trip = await asOwner(async (tx) => {
    const t = await tx.query<{ id: string }>(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, $4, $5, 1000, 420, 430, 455, 485, 520, $6) returning id`,
      [today, scene.orderId, 1 + (n++ % 90), scene.truckId, driverId, owner.id],
    );
    return t.rows[0]!.id;
  });
  if (loaded) await plantLoads(trip);
  return trip;
}
async function plantLoads(tripId: string) {
  await asOwner(async (tx) => {
    const d = await insertDelivery(tx, owner.id, scene, 1000);
    const id = (await tx.query<{ id: string }>('select id from delivery where bl_no = $1', [d.blNo])).rows[0]!
      .id;
    await tx.query(
      `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, 'loaded', now() - interval '1 minute', $2, $3)`,
      [tripId, id, owner.id],
    );
  });
}
const tap = (tripId: string, step: string, extra: Record<string, unknown> = {}) => ({
  kind: 'step' as const,
  key: randomUUID().replace(/-/g, ''),
  tripId,
  step,
  at: new Date().toISOString(),
  ...extra,
});

beforeAll(async () => {
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'office_sales');
  scene = await deliveryScene(app, owner.id, marker);
});

describe('sign-in: a PIN and one bound phone (AC-PROD-25)', () => {
  it('binds the first phone, knows it again, refuses another, and the owner can release it', async () => {
    const d = await newDriver();
    await setDriverPin(deps(), owner, { driverId: d.id, pin: '482913' });
    const a = device();
    expect((await signIn(d, '482913', a)).ok).toBe(true);
    expect((await signIn(d, '482913', a)).ok).toBe(true);
    expect(await signIn(d, '482913', device())).toEqual({ ok: false, error: 'OTHER_DEVICE' });
    const accounts = await listFieldAccounts(deps(), owner);
    expect(accounts.find((x) => x.driverId === d.id)).toMatchObject({ hasAccount: true, hasPin: true });
    expect(await revokeDriverDevice(deps(), owner, d.id)).toBe(true);
    const b = device();
    expect((await signIn(d, '482913', b)).ok).toBe(true);
    // the first phone's token stops working at once
    const old = await loginDriver(deps(), { code: d.code, pin: '482913', deviceId: a }, new Date());
    expect(old).toEqual({ ok: false, error: 'OTHER_DEVICE' });
  });

  it('a token of a released phone is refused by the database on the next request', async () => {
    const d = await newDriver();
    const s = await sessionFor(d);
    expect(await sessionOfToken({ authPool: kit.authPool }, s.token)).not.toBeNull();
    await revokeDriverDevice(deps(), owner, d.id);
    expect(await sessionOfToken({ authPool: kit.authPool }, s.token)).toBeNull();
    expect(hashDeviceId(secret, s.dev)).toBe(s.token.deviceHash);
  });

  it('five wrong PINs lock the driver; the right PIN is then refused until the lock ends or the PIN is reset', async () => {
    const d = await newDriver();
    await setDriverPin(deps(), owner, { driverId: d.id, pin: '482913' });
    const dev = device();
    for (let i = 0; i < 4; i++) expect(await signIn(d, '918204', dev)).toEqual({ ok: false, error: 'WRONG' });
    expect(await signIn(d, '918204', dev)).toEqual({ ok: false, error: 'LOCKED' });
    expect(await signIn(d, '482913', dev)).toEqual({ ok: false, error: 'LOCKED' });
    await setDriverPin(deps(), owner, { driverId: d.id, pin: '735109' });
    expect((await signIn(d, '735109', dev)).ok).toBe(true);
  });

  it('F11: parallel wrong PINs cannot get past the limit of five, and a correct PIN after the lock cannot clear it', async () => {
    const d = await newDriver();
    await setDriverPin(deps(), owner, { driverId: d.id, pin: '482913' });
    const dev = device();
    const storm = await Promise.all(Array.from({ length: 24 }, () => signIn(d, '918204', dev)));
    const verdicts = storm.map((r) => (r.ok ? 'ok' : r.error));
    // exactly four attempts were checked and found wrong; the fifth locks; every other one is refused unchecked
    expect(verdicts.filter((v) => v === 'WRONG')).toHaveLength(4);
    expect(verdicts.filter((v) => v === 'LOCKED')).toHaveLength(20);
    const acct = (await listFieldAccounts(deps(), owner)).find((a) => a.driverId === d.id);
    expect(acct?.lockedUntil).not.toBeNull();
    // the correct PIN arrives late, in parallel with more wrong ones: nobody gets in, the lock stays
    const late = await Promise.all([
      signIn(d, '482913', dev),
      signIn(d, '918204', dev),
      signIn(d, '482913', dev),
    ]);
    expect(late.every((r) => !r.ok && r.error === 'LOCKED')).toBe(true);
    // and the database itself refuses to issue a session on a locked driver, whatever the caller checked
    const direct = await kit.authPool.query<{ r: string }>('select public.field_login_ok($1, $2, $3) as r', [
      d.id,
      hashDeviceId(secret, dev),
      '',
    ]);
    expect(direct.rows[0]?.r).toBe('locked');
  });

  it('an unknown code, a malformed PIN and a trivial PIN are refused alike; only the owner roles manage accounts', async () => {
    expect(
      await loginDriver(deps(), { code: 'CH-9999', pin: '482913', deviceId: device() }, new Date()),
    ).toEqual({ ok: false, error: 'WRONG' });
    expect(await loginDriver(deps(), { code: 'nope', pin: 'abc', deviceId: device() }, new Date())).toEqual({
      ok: false,
      error: 'INVALID',
    });
    const d = await newDriver();
    expect(await setDriverPin(deps(), owner, { driverId: d.id, pin: '123456' })).toEqual({
      ok: false,
      error: 'TOO_EASY',
    });
    // F11: the shortest PIN that can be set is six digits
    for (const short of ['1234', '48291'])
      expect(await setDriverPin(deps(), owner, { driverId: d.id, pin: short })).toEqual({
        ok: false,
        error: 'INVALID',
      });
    expect((await setDriverPin(deps(), owner, { driverId: d.id, pin: '48291357' })).ok).toBe(true);
    // an older, shorter PIN is still recognised at sign-in (it is wrong here, not malformed)
    expect(await signIn(d, '4829', device())).toEqual({ ok: false, error: 'WRONG' });
    await expect(setDriverPin(deps(), office, { driverId: d.id, pin: '482913' })).rejects.toThrow();
    await expect(createFieldAccount(deps(), office, d.id)).rejects.toThrow();
  });
});

describe('the day of a driver: own rotations, never a price (AC-PROD-20, 21)', () => {
  it('reads only its own rotations; the answer holds no money key; the address and phone are opened server-side', async () => {
    const mine = await newDriver();
    const other = await newDriver();
    const a = await sessionFor(mine);
    const b = await sessionFor(other);
    const t1 = await tripFor(mine.id, false);
    await tripFor(other.id, false);
    const day = await getDriverDay(app, a.user, today, cipher);
    expect(day.trips.map((t) => t.id)).toEqual([t1]);
    expect(await getDriverDay(app, b.user, today, cipher).then((d) => d.trips.some((t) => t.id === t1))).toBe(
      false,
    );
    const text = JSON.stringify(day);
    expect(text).not.toMatch(/price|prix|amount|total|centimes|balance|\bMAD\b|ttc|vat/i);
    expect(Object.keys(day.trips[0]!).sort()).toEqual(
      [
        'address',
        'blNo',
        'blPhotos',
        'clientName',
        'contactName',
        'id',
        'loadMin',
        'loadingStartedAt',
        'mapUrl',
        'orderCode',
        'phone',
        'seq',
        'siteLabel',
        'stage',
        'steps',
        'truckCode',
        'typeLabel',
        'unloadedL',
        'volumeL',
        'zoneName',
      ].sort(),
    );
  });

  it('the six taps run in order; departing waits for the plant’s load; a replay changes nothing; the m3 is required at the end of unloading', async () => {
    const d = await newDriver();
    const s = await sessionFor(d);
    const trip = await tripFor(d.id, false);
    const start = tap(trip, 'loading_started');
    const early = tap(trip, 'departed');
    let r = await syncActions(app, s.user, [start, early]);
    expect(r).toEqual({
      ok: true,
      value: [
        { key: start.key, status: 'recorded' },
        { key: early.key, status: 'rejected', code: 'wait_previous', retry: true },
      ],
    });
    // the same start again (lost answer): replayed, nothing stored twice
    r = await syncActions(app, s.user, [start]);
    expect(r).toEqual({ ok: true, value: [{ key: start.key, status: 'replayed' }] });
    await plantLoads(trip);
    const rest = [early, tap(trip, 'arrived'), tap(trip, 'unloading_started')];
    r = await syncActions(app, s.user, rest);
    expect(r.ok && r.value.map((o) => o.status)).toEqual(['recorded', 'recorded', 'recorded']);
    const noVolume = tap(trip, 'unloading_finished');
    r = await syncActions(app, s.user, [noVolume]);
    expect(r.ok && r.value[0]).toMatchObject({ status: 'rejected', retry: false });
    const fin = tap(trip, 'unloading_finished', { volumeL: 9500 });
    const back = tap(trip, 'back');
    r = await syncActions(app, s.user, [fin, back]);
    expect(r.ok && r.value.map((o) => o.status)).toEqual(['recorded', 'recorded']);
    const day = await getDriverDay(app, s.user, today, cipher);
    expect(day.trips[0]).toMatchObject({ unloadedL: 9500, stage: 'back' });
    expect(Object.keys(day.trips[0]!.steps)).toEqual(
      expect.arrayContaining([
        'loaded',
        'departed',
        'arrived',
        'unloading_started',
        'unloading_finished',
        'back',
      ]),
    );
    // unloading ended marks the load delivered (the existing tracking rule)
    const delivered = await asOwner((tx) =>
      tx.query(
        'select 1 from delivery_delivered d join trip_event e on e.id = d.trip_event_id where e.trip_id = $1',
        [trip],
      ),
    );
    expect(delivered.rowCount).toBe(1);
  });

  it('a driver cannot touch another driver’s rotation, and a tap in the future or long ago is refused', async () => {
    const mine = await newDriver();
    const other = await newDriver();
    const a = await sessionFor(mine);
    const theirs = await tripFor(other.id, false);
    const r = await syncActions(app, a.user, [tap(theirs, 'loading_started')]);
    expect(r.ok && r.value[0]).toMatchObject({ status: 'rejected', code: 'forbidden', retry: false });
    const mineTrip = await tripFor(mine.id, false);
    const future = await syncActions(app, a.user, [
      tap(mineTrip, 'loading_started', { at: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);
    expect(future.ok && future.value[0]).toMatchObject({ status: 'rejected', code: 'invalid' });
    const old = await syncActions(app, a.user, [
      tap(mineTrip, 'loading_started', { at: new Date(Date.now() - 5 * 86_400_000).toISOString() }),
    ]);
    expect(old.ok && old.value[0]).toMatchObject({ status: 'rejected', code: 'invalid' });
  });

  it('a malformed batch is refused whole', async () => {
    const d = await newDriver();
    const s = await sessionFor(d);
    expect(await syncActions(app, s.user, [{ kind: 'step', key: 'x' }])).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await syncActions(app, s.user, 'nope')).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('emergency and the office instructions (AC-PROD-22, 23)', () => {
  it('offers the options of the current step only, and the office sees the alert', async () => {
    const d = await newDriver();
    const s = await sessionFor(d);
    const trip = await tripFor(d.id, true);
    await syncActions(app, s.user, [
      tap(trip, 'departed'),
      tap(trip, 'arrived'),
      tap(trip, 'unloading_started'),
    ]);
    const key = randomUUID().replace(/-/g, '');
    const bad = {
      kind: 'emergency' as const,
      key: randomUUID().replace(/-/g, ''),
      tripId: trip,
      option: 'site_closed',
      at: new Date().toISOString(),
    };
    const r1 = await syncActions(app, s.user, [bad]);
    expect(r1.ok && r1.value[0]).toMatchObject({ status: 'rejected', code: 'invalid' });
    const good = {
      kind: 'emergency' as const,
      key,
      tripId: trip,
      option: 'load_not_enough',
      at: new Date().toISOString(),
      pctUnloaded: 70,
    };
    const r2 = await syncActions(app, s.user, [good, good]);
    expect(r2.ok && r2.value.map((o) => o.status)).toEqual(['recorded', 'replayed']);
    const list = await listEmergencies(app, office);
    const mine = list.find((e) => e.tripId === trip && e.option === 'load_not_enough');
    expect(mine).toMatchObject({
      step: 'unloading_started',
      pctUnloaded: 70,
      driverName: expect.stringContaining(marker),
    });
    expect(JSON.stringify(list)).not.toMatch(/price|centimes|amount|total/i);
    // R5: the emergency reaches the office's bell as an urgent notification, with the option and no amount
    const bell = await listMyNotifications(app, office, 50);
    expect(
      bell.some(
        (n) => n.kind === 'emergency' && n.severity === 'urgent' && n.params.option === 'load_not_enough',
      ),
    ).toBe(true);
    // a driver cannot list emergencies
    await expect(listEmergencies(app, s.user)).rejects.toThrow();
  });

  it('the office redirects: the new address reaches the driver (sealed in the database), who acknowledges', async () => {
    const d = await newDriver();
    const s = await sessionFor(d);
    const trip = await tripFor(d.id, true);
    await syncActions(app, s.user, [tap(trip, 'departed')]);
    const e = {
      kind: 'emergency' as const,
      key: randomUUID().replace(/-/g, ''),
      tripId: trip,
      option: 'client_cancelled',
      at: new Date().toISOString(),
    };
    await syncActions(app, s.user, [e]);
    const emergency = (await listEmergencies(app, office)).find((x) => x.tripId === trip)!;
    expect(
      (await instructDriver(app, office, { emergencyId: emergency.id, kind: 'redirect' }, cipher)).ok,
    ).toBe(false);
    const made = await instructDriver(
      app,
      office,
      {
        emergencyId: emergency.id,
        kind: 'redirect',
        address: '12 rue Exemple, Martil',
        note: 'rappeler le client',
      },
      cipher,
    );
    if (!made.ok) throw new Error(made.error);
    const raw = await asOwner((tx) =>
      tx.query<{ address_enc: string }>('select address_enc from trip_instruction where id = $1', [
        made.value.id,
      ]),
    );
    expect(raw.rows[0]?.address_enc).not.toContain('Martil');
    const day = await getDriverDay(app, s.user, today, cipher);
    const ins = day.instructions.find((i) => i.id === made.value.id);
    expect(ins).toMatchObject({ kind: 'redirect', address: '12 rue Exemple, Martil', acknowledgedAt: null });
    // F07: the address is text for the driver; no external map link unless the operator switched it on
    expect(ins?.mapUrl).toBeNull();
    // R5: the instruction reaches that driver's own notifications, and nobody else's
    expect(
      (await listMyNotifications(app, s.user, 20)).some(
        (n) => n.kind === 'driver_instruction' && n.params.instruction === 'redirect',
      ),
    ).toBe(true);
    const ack = {
      kind: 'ack' as const,
      key: randomUUID().replace(/-/g, ''),
      instructionId: made.value.id,
      at: new Date().toISOString(),
    };
    expect((await syncActions(app, s.user, [ack])).ok).toBe(true);
    expect(
      (await getDriverDay(app, s.user, today, cipher)).instructions.find((i) => i.id === made.value.id)
        ?.acknowledgedAt,
    ).not.toBeNull();
    // another driver cannot acknowledge it
    const other = await newDriver();
    const o = await sessionFor(other);
    const r = await syncActions(app, o.user, [{ ...ack, key: randomUUID().replace(/-/g, '') }]);
    expect(r.ok && r.value[0]).toMatchObject({ status: 'rejected', code: 'forbidden' });
  });
});

describe('the pump operator (AC-PROD-26)', () => {
  it('has five steps in order and records the m3 pumped; only its own jobs', async () => {
    const op = await newDriver('pump_operator');
    const s = await sessionFor(op);
    const pump = await asOwner((tx) =>
      tx.query<{ id: string }>(
        `insert into truck (id, code, plate, kind) values (gen_random_uuid(), $1, $2, 'pump') returning id`,
        [`P${n++ % 900}`, `PM-${marker.slice(0, 8)}${n}`],
      ),
    );
    const made = await createPumpJob(
      app,
      office,
      {
        date: today,
        pumpId: pump.rows[0]!.id,
        operatorId: op.id,
        siteLabel: `Chantier ${marker}`,
        address: '5 avenue Test',
        plannedM3: 30,
      },
      cipher,
    );
    if (!made.ok) throw new Error(made.error);
    const job = made.value.id;
    const step = (st: string, extra: Record<string, unknown> = {}) => ({
      kind: 'pump' as const,
      key: randomUUID().replace(/-/g, ''),
      jobId: job,
      step: st,
      at: new Date().toISOString(),
      ...extra,
    });
    let r = await syncActions(app, s.user, [step('set_up')]);
    expect(r.ok && r.value[0]).toMatchObject({ status: 'rejected', code: 'wait_previous', retry: true });
    r = await syncActions(app, s.user, [step('arrived'), step('set_up'), step('pumping_started')]);
    expect(r.ok && r.value.map((o) => o.status)).toEqual(['recorded', 'recorded', 'recorded']);
    r = await syncActions(app, s.user, [step('pumping_ended')]);
    expect(r.ok && r.value[0]).toMatchObject({ status: 'rejected' });
    r = await syncActions(app, s.user, [step('pumping_ended', { m3: 28 }), step('left')]);
    expect(r.ok && r.value.map((o) => o.status)).toEqual(['recorded', 'recorded']);
    const day = await getPumpDay(app, s.user, today, cipher);
    expect(day[0]).toMatchObject({
      steps: expect.arrayContaining(['left']),
      m3Pumped: 28,
      address: '5 avenue Test',
    });
    expect(JSON.stringify(day)).not.toMatch(/price|centimes|amount|total/i);
    const other = await newDriver('pump_operator');
    const o = await sessionFor(other);
    expect(await getPumpDay(app, o.user, today, cipher)).toEqual([]);
    const rr = await syncActions(app, o.user, [step('arrived')]);
    expect(rr.ok && rr.value[0]).toMatchObject({ status: 'rejected', code: 'forbidden' });
  });
});
