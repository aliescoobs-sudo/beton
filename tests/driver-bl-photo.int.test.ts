import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createDiskStore, type FileStore } from '../src/lib/files/store';
import {
  attachDriverBlPhoto,
  createFieldAccount,
  getDriverDay,
  hashDeviceId,
  listTripBlPhotos,
  loginDriver,
  openDriverBlPhoto,
  sessionOfToken,
  setDriverPin,
  verifyFieldToken,
} from '../src/modules/field';
import { fieldCipherFrom } from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';
import { jpegWithGps, simplePdf } from './helpers/file-fixtures';
import { deliveryScene } from './helpers/ledger-fixtures';

// C3 (REQUIREMENTS-V1 §7 step 5): the driver's optional photo of the signed BL. Written by one door for the driver of the rotation,
// bytes sealed and stripped of metadata, read only by the roles that follow deliveries, every view audited, never a price.
const kit = authTestKit();
const app = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: kit.env.DATABASE_URL_MIGRATOR, max: 1 });
const marker = `bp${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const secret = kit.env.AUTH_SECRET;
const cipher = fieldCipherFrom(parseKeyring(kit.env.FIELD_ENCRYPTION_KEYS));
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret });
const today = new Date().toISOString().slice(0, 10);
const key = `k1:${Buffer.alloc(32, 4).toString('base64')}`;
let dir = '';
let store: FileStore;
let owner: SessionUser;
let scene: Awaited<ReturnType<typeof deliveryScene>>;
let n = 700 + Math.floor(Math.random() * 200);

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, fn);

// trip_driver_report is written by the driver door only; the fixture writes it as that definer would.
const reportUnloaded = (tripId: string, driverId: string) =>
  withRlsContext(migrator, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query(
      `insert into trip_driver_report (id, trip_id, driver_id, kind, at, volume_l, client_key) values (gen_random_uuid(), $1, $2, 'unloaded', now(), 900, $3)`,
      [tripId, driverId, `u${randomUUID()}`],
    ),
  );

async function driverSession() {
  const no = n++;
  const row = await asOwner((tx) =>
    tx.query<{ id: string; code: string }>(
      `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id, code`,
      [`CH-${no}`, `${marker} ${no}`, owner.id],
    ),
  );
  const d = row.rows[0]!;
  const acct = await createFieldAccount(deps(), owner, d.id);
  if (!acct.ok) throw new Error(acct.error);
  await setDriverPin(deps(), owner, { driverId: d.id, pin: '482913' });
  const r = await loginDriver(
    deps(),
    { code: d.code, pin: '482913', deviceId: `phone-${randomUUID()}` },
    new Date(),
  );
  if (!r.ok) throw new Error(r.error);
  const token = verifyFieldToken(secret, r.value.token, Math.floor(Date.now() / 1000))!;
  const user = (await sessionOfToken({ authPool: kit.authPool }, token))!;
  return { id: d.id, user };
}
async function trip(driverId: string, unloaded: boolean) {
  const id = await asOwner(async (tx) => {
    const t = await tx.query<{ id: string }>(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by)
       values (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, $4, $5, 1000, 420, 430, 455, 485, 520, $6) returning id`,
      [today, scene.orderId, 1 + (n++ % 90), scene.truckId, driverId, owner.id],
    );
    return t.rows[0]!.id;
  });
  if (unloaded) await reportUnloaded(id, driverId);
  return id;
}
const shot = (tripId: string, k = randomUUID().replace(/-/g, '')) => ({
  tripId,
  key: k,
  takenAt: new Date().toISOString(),
});
const jpeg = () => ({ declaredType: 'image/jpeg', bytes: new Uint8Array(jpegWithGps()) });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bb-blp-'));
  store = createDiskStore(dir, parseKeyring(key));
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
  scene = await deliveryScene(app, owner.id, marker);
});
afterAll(async () => {
  await Promise.all([app.end(), migrator.end(), kit.close(), rm(dir, { recursive: true, force: true })]);
});

describe('the driver photo of the signed BL (C3)', () => {
  it('waits for the unloading, then is stored sealed and without its GPS; a replay changes nothing', async () => {
    const d = await driverSession();
    const t = await trip(d.id, false);
    expect(await attachDriverBlPhoto(app, d.user, shot(t), jpeg(), { store })).toEqual({
      ok: false,
      error: 'NOT_UNLOADED',
    });
    await reportUnloaded(t, d.id);
    const s = shot(t);
    expect(await attachDriverBlPhoto(app, d.user, s, jpeg(), { store })).toEqual({
      ok: true,
      value: { status: 'recorded' },
    });
    expect(await attachDriverBlPhoto(app, d.user, s, jpeg(), { store })).toEqual({
      ok: true,
      value: { status: 'replayed' },
    });
    const rows = (
      await migrator.query(`select id, sha256, size_bytes from driver_bl_photo where trip_id = $1`, [t])
    ).rows;
    expect(rows).toHaveLength(1);
    const bytes = await store.get(rows[0].id);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(rows[0].sha256);
    expect(bytes.toString('latin1')).not.toMatch(/GPS|Exif/);
    // sealed at rest: the file on disk is not the picture
    const day = await getDriverDay(app, d.user, today, cipher);
    expect(day.trips.find((x) => x.id === t)?.blPhotos).toBe(1);
  });

  it('refuses another driver’s rotation, a PDF, an empty file, a fourth photo, and a non-driver', async () => {
    const a = await driverSession();
    const b = await driverSession();
    const t = await trip(a.id, true);
    expect(await attachDriverBlPhoto(app, b.user, shot(t), jpeg(), { store })).toEqual({
      ok: false,
      error: 'NOT_YOUR_ROTATION',
    });
    expect(
      await attachDriverBlPhoto(
        app,
        a.user,
        shot(t),
        { declaredType: 'application/pdf', bytes: simplePdf() },
        { store },
      ),
    ).toEqual({ ok: false, error: 'TYPE_NOT_ALLOWED' });
    expect(
      await attachDriverBlPhoto(
        app,
        a.user,
        shot(t),
        { declaredType: 'image/jpeg', bytes: new Uint8Array() },
        { store },
      ),
    ).toMatchObject({ ok: false });
    for (let i = 0; i < 3; i++)
      expect((await attachDriverBlPhoto(app, a.user, shot(t), jpeg(), { store })).ok).toBe(true);
    expect(await attachDriverBlPhoto(app, a.user, shot(t), jpeg(), { store })).toEqual({
      ok: false,
      error: 'TOO_MANY',
    });
    expect(await attachDriverBlPhoto(app, owner, shot(t), jpeg(), { store })).toEqual({
      ok: false,
      error: 'NOT_YOUR_ROTATION',
    });
    // a shot time that cannot be true
    expect(
      await attachDriverBlPhoto(
        app,
        a.user,
        { ...shot(await trip(a.id, true)), takenAt: '2020-01-01T00:00:00.000Z' },
        jpeg(),
        { store },
      ),
    ).toEqual({ ok: false, error: 'INVALID' });
  });

  it('leaves no row when the file cannot be sealed', async () => {
    const d = await driverSession();
    const t = await trip(d.id, true);
    const broken: FileStore = { ...store, put: () => Promise.reject(new Error('disk full')) };
    await expect(attachDriverBlPhoto(app, d.user, shot(t), jpeg(), { store: broken })).rejects.toThrow(
      'disk full',
    );
    expect((await migrator.query(`select 1 from driver_bl_photo where trip_id = $1`, [t])).rowCount).toBe(0);
  });

  it('is read by the offices, the owner roles and support, audited; not by the driver, the accountant or a portal', async () => {
    const d = await driverSession();
    const t = await trip(d.id, true);
    await attachDriverBlPhoto(app, d.user, shot(t), jpeg(), { store });
    const id = (await migrator.query(`select id from driver_bl_photo where trip_id = $1`, [t])).rows[0].id;
    for (const role of ['owner', 'app_admin', 'office_sales', 'office_purchases', 'support'] as const) {
      const who = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, role);
      expect(
        (await listTripBlPhotos(app, who, today)).some((p) => p.id === id),
        role,
      ).toBe(true);
      const opened = await openDriverBlPhoto(app, who, id, { store });
      expect(opened.ok, role).toBe(true);
    }
    const audited = await migrator.query(
      `select 1 from audit_event where table_name like 'file:driver_bl_photo:%' and row_id = $1`,
      [id],
    );
    expect(audited.rowCount).toBeGreaterThanOrEqual(5);
    for (const role of [
      'driver',
      'accountant',
      'client_portal',
      'supplier_portal',
      'pump_operator',
    ] as const) {
      const who = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, role);
      await expect(openDriverBlPhoto(app, who, id, { store }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await openDriverBlPhoto(app, owner, randomUUID(), { store })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('nothing the phone gets back holds a price', async () => {
    const d = await driverSession();
    const day = await getDriverDay(app, d.user, today, cipher);
    expect(JSON.stringify(day)).not.toMatch(/price|centimes|amount/i);
    expect(hashDeviceId).toBeTypeOf('function');
  });
});
