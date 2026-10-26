import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { createDiskStore } from '../src/lib/files/store';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  attachDeliveryScan,
  cancelLoad,
  openDeliveryScan,
  recordBlReturnWithScan,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { setParameter } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { jpegWithGps, pngWithText, simplePdf } from './helpers/file-fixtures';
import { deliveryScene, type DeliveryScene, newDelivery } from './helpers/ledger-fixtures';

// integration I1.2: the signed BL and its optional scan. AC-INT-02 (marked once, scan optional), AC-INT-03 (type, magic
// bytes, size, metadata stripped, sealed at rest), AC-INT-04 (opened only through the permission and RLS, every view audited).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `df${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let scene: DeliveryScene;
let dir = '';
const key = `k1:${Buffer.alloc(32, 9).toString('base64')}`;
const store = () => createDiskStore(dir, parseKeyring(key));
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const delivery = async (l = 100) => (await newDelivery(app, users.owner.id, marker, scene, l)).id;
const returnOf = (
  actor: SessionUser,
  deliveryId: string,
  upload: Parameters<typeof recordBlReturnWithScan>[3],
) =>
  recordBlReturnWithScan(app, actor, { deliveryId, returnedOn: '2026-06-02', returnedVolumeL: 0 }, upload, {
    store: store(),
  });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bb-df-'));
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});
afterAll(async () => {
  await Promise.all([app.end(), migrator.end(), rm(dir, { recursive: true, force: true })]);
});

describe('the signed BL comes back with or without a scan (AC-INT-02)', () => {
  it('without a scan: recorded once, a second attempt is refused', async () => {
    const id = await delivery();
    expect(await returnOf(users.plant, id, null)).toMatchObject({ ok: true, value: { scanId: null } });
    expect(await returnOf(users.office, id, null)).toEqual({ ok: false, error: 'ALREADY_RETURNED' });
  });

  it('with a photo: the return and the scan are recorded together; the GPS and comment are gone from what is stored', async () => {
    const id = await delivery();
    const r = await returnOf(users.plant, id, { declaredType: 'image/jpeg', bytes: jpegWithGps() });
    if (!r.ok) throw new Error(String(r.error));
    const scanId = (r.value as { scanId: string }).scanId;
    const row = await inCtx(users.owner, (tx) =>
      tx.query<{ content_type: string; size_bytes: number; sha256: string }>(
        `select content_type, size_bytes, sha256 from delivery_file where id = $1`,
        [scanId],
      ),
    );
    expect(row.rows[0]).toMatchObject({ content_type: 'image/jpeg' });
    const stored = await store().get(scanId);
    expect(stored.length).toBe(row.rows[0]?.size_bytes);
    for (const secret of ['GPS-LAT', 'SECRET-COMMENT']) expect(stored.includes(secret)).toBe(false);
    expect(stored.length).toBeLessThan(jpegWithGps().length);
  });

  it('a refused file records nothing, not even the return', async () => {
    const id = await delivery();
    expect(
      await returnOf(users.plant, id, {
        declaredType: 'text/html',
        bytes: Buffer.from('<script>1</script>'),
      }),
    ).toEqual({ ok: false, error: 'TYPE_NOT_ALLOWED' });
    expect(await returnOf(users.plant, id, { declaredType: 'image/png', bytes: jpegWithGps() })).toEqual({
      ok: false,
      error: 'TYPE_MISMATCH',
    });
    expect(
      await returnOf(users.plant, id, {
        declaredType: 'application/pdf',
        bytes: simplePdf('/JavaScript (x) '),
      }),
    ).toEqual({ ok: false, error: 'ACTIVE_CONTENT' });
    const rows = await migrator.query(`select 1 from delivery_return where delivery_id = $1`, [id]);
    expect(rows.rowCount).toBe(0);
    // and the person can try again with a good file
    expect(
      (await returnOf(users.plant, id, { declaredType: 'application/pdf', bytes: simplePdf() })).ok,
    ).toBe(true);
  });

  it('the size limit is a parameter the plant is held to', async () => {
    const id = await delivery();
    await setParameter(app, users.owner, 'upload_max_bytes', 100_000);
    try {
      expect(
        await returnOf(users.plant, id, { declaredType: 'image/png', bytes: pngWithText(200_000) }),
      ).toEqual({ ok: false, error: 'TOO_LARGE' });
      expect(
        (await returnOf(users.plant, id, { declaredType: 'image/png', bytes: pngWithText(50_000) })).ok,
      ).toBe(true);
    } finally {
      await setParameter(app, users.owner, 'upload_max_bytes', 5_000_000);
    }
  });

  it('a scan can be added later, once; not before the return, not on a cancelled load; support cannot add', async () => {
    const id = await delivery();
    const png = { declaredType: 'image/png', bytes: pngWithText() };
    expect(await attachDeliveryScan(app, users.office, { deliveryId: id }, png, { store: store() })).toEqual({
      ok: false,
      error: 'NO_RETURN',
    });
    expect((await returnOf(users.office, id, null)).ok).toBe(true);
    expect(
      (await attachDeliveryScan(app, users.office, { deliveryId: id }, png, { store: store() })).ok,
    ).toBe(true);
    expect(await attachDeliveryScan(app, users.plant, { deliveryId: id }, png, { store: store() })).toEqual({
      ok: false,
      error: 'ALREADY_HAS_SCAN',
    });
    await expect(
      attachDeliveryScan(app, users.support, { deliveryId: id }, png, { store: store() }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const gone = await delivery();
    expect((await returnOf(users.plant, gone, null)).ok).toBe(true);
    expect(
      (await cancelLoad(app, users.owner, { deliveryId: gone, reason: 'erreur' }, { today: '2026-06-02' }))
        .ok,
    ).toBe(true);
    expect(await attachDeliveryScan(app, users.plant, { deliveryId: gone }, png, { store: store() })).toEqual(
      {
        ok: false,
        error: 'NOT_FOUND',
      },
    );
  });
});

describe('what is on disk (AC-INT-03)', () => {
  it('is sealed: no plain picture, no readable text, named by id only, outside the source tree', async () => {
    const files: string[] = [];
    for (const shard of await readdir(dir))
      for (const f of await readdir(path.join(dir, shard))) files.push(path.join(dir, shard, f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = await readFile(file);
      expect(bytes.subarray(0, 4).toString()).toBe('BBF1');
      expect(bytes.includes(Buffer.from('SECRET'))).toBe(false);
      expect(bytes.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
      expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}\.bin$/);
    }
    expect(path.resolve(dir).startsWith(path.resolve('public'))).toBe(false);
  });
});

describe('opening a scan (AC-INT-04)', () => {
  let id = '';
  let scanId = '';
  beforeAll(async () => {
    id = await delivery();
    const r = await returnOf(users.plant, id, { declaredType: 'image/png', bytes: pngWithText() });
    scanId = (r as { value: { scanId: string } }).value.scanId;
  });

  it.each(['owner', 'partner', 'office', 'plant', 'support'] as const)(
    '%s opens it, and the view is audited',
    async (role) => {
      const before = await migrator.query<{ n: string }>(
        `select count(*)::text as n from audit_event where action = 'view' and table_name like 'file:bl_scan:%' and row_id = $1 and actor_user_id = $2`,
        [scanId, users[role].id],
      );
      const opened = await openDeliveryScan(app, users[role], id, { store: store() });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.value.contentType).toBe('image/png');
        expect(opened.value.bytes.includes('SECRET-AUTHOR')).toBe(false);
      }
      const after = await migrator.query<{ n: string }>(
        `select count(*)::text as n from audit_event where action = 'view' and table_name like 'file:bl_scan:%' and row_id = $1 and actor_user_id = $2`,
        [scanId, users[role].id],
      );
      expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
    },
  );

  it('an unknown delivery or one without a scan is not found', async () => {
    expect(await openDeliveryScan(app, users.plant, randomUUID(), { store: store() })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await openDeliveryScan(app, users.plant, 'not-a-uuid', { store: store() })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('a file altered on disk or sealed for another record is refused, not served', async () => {
    const file = path.join(dir, scanId.slice(0, 2), `${scanId}.bin`);
    const good = await readFile(file);
    const altered = Buffer.from(good);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    await writeFile(file, altered);
    expect(await openDeliveryScan(app, users.owner, id, { store: store() })).toEqual({
      ok: false,
      error: 'CORRUPT',
    });
    await writeFile(file, good);
    expect((await openDeliveryScan(app, users.owner, id, { store: store() })).ok).toBe(true);
  });

  it('the database refuses a scan to a role that may not add one, and an update or a delete to anyone', async () => {
    await expect(
      inCtx(users.support, (tx) =>
        tx.query(
          `insert into delivery_file (id, delivery_id, content_type, size_bytes, sha256, uploaded_by) values (gen_random_uuid(), $1, 'image/png', 1, repeat('a', 64), $2)`,
          [id, users.support.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    for (const sql of ['update delivery_file set size_bytes = 1', 'delete from delivery_file']) {
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });
});
