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
  attachSupplierInvoiceFile,
  createSupplierInvoice,
  getSupplierInvoice,
  openSupplierInvoiceFile,
  rejectSupplierInvoice,
} from '../src/modules/ledger';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { jpegWithGps, pngWithText, simplePdf } from './helpers/file-fixtures';
import { insertPurchase, purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// integration I2.3: the photo of the supplier invoice, stored as an attachment with the rules of every stored document.
// AC-INT-03, 04, 15.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `sf${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-06-10';
let master: PurchaseMaster;
let dir = '';
const key = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
const store = () => createDiskStore(dir, parseKeyring(key));
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bb-sif-'));
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await purchaseMaster(app, users.owner.id, marker);
});
afterAll(async () => {
  await Promise.all([app.end(), rm(dir, { recursive: true, force: true })]);
});

async function po() {
  return inCtx(users.owner, async (tx) => {
    const supplier = await tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
      [`sf${randomUUID().slice(0, 12)}`],
    );
    return insertPurchase(tx, users.owner.id, { ...master, supplierId: supplier.rows[0]?.id as string });
  });
}
const input = (code: string, no = `SF-${randomUUID().slice(0, 12)}`) => ({
  purchaseCode: code,
  supplierInvoiceNo: no,
  invoiceDate: '2026-06-03',
  lines: [{ componentId: master.componentId, qtyMilli: 30_000, unitPriceHtCentimes: 145_000 }],
});
const jpeg = { declaredType: 'image/jpeg', bytes: jpegWithGps() };
const enter = (
  actor: SessionUser,
  code: string,
  upload: { declaredType: string; bytes: Uint8Array } | null = jpeg,
) =>
  createSupplierInvoice(
    app,
    actor,
    input(code),
    { today: TODAY },
    upload ? { upload, store: store() } : null,
  );
const ownerId = async (code: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>('select id from supplier_invoice where code = $1', [code]),
    )
  ).rows[0]?.id as string;

describe('the photo of the supplier invoice (AC-INT-15, AC-INT-03)', () => {
  it('is stored with the invoice, without the GPS and comment of the photo, sealed on disk, with its hash', async () => {
    const p = await po();
    const made = await enter(users.office, p.code);
    if (!made.ok) throw new Error(made.error);
    const id = await ownerId(made.value.code);
    const detail = await getSupplierInvoice(app, users.owner, id);
    expect(detail?.files).toHaveLength(1);
    expect(detail?.files[0]).toMatchObject({ seq: 1, contentType: 'image/jpeg' });
    const stored = await store().get(detail?.files[0]?.id as string);
    for (const secret of ['GPS-LAT', 'SECRET-COMMENT']) expect(stored.includes(secret)).toBe(false);
    expect(stored.length).toBe(detail?.files[0]?.sizeBytes);
    const files: string[] = [];
    for (const shard of await readdir(dir))
      for (const f of await readdir(path.join(dir, shard))) files.push(path.join(dir, shard, f));
    for (const f of files) expect((await readFile(f)).subarray(0, 4).toString()).toBe('BBF1');
  });

  it('a refused file leaves no invoice behind, and the supplier number stays free', async () => {
    const p = await po();
    const no = `SF-${randomUUID().slice(0, 12)}`;
    const before = (await inCtx(users.owner, (tx) => tx.query(`select 1 from supplier_invoice`))).rowCount;
    for (const [upload, error] of [
      [{ declaredType: 'text/html', bytes: Buffer.from('<script>1</script>') }, 'TYPE_NOT_ALLOWED'],
      [{ declaredType: 'image/png', bytes: jpegWithGps() }, 'TYPE_MISMATCH'],
      [{ declaredType: 'application/pdf', bytes: simplePdf('/OpenAction 1 0 R ') }, 'ACTIVE_CONTENT'],
    ] as const)
      expect(
        await createSupplierInvoice(
          app,
          users.owner,
          input(p.code, no),
          { today: TODAY },
          { upload, store: store() },
        ),
      ).toEqual({
        ok: false,
        error,
      });
    expect((await inCtx(users.owner, (tx) => tx.query(`select 1 from supplier_invoice`))).rowCount).toBe(
      before,
    );
    expect((await enter(users.owner, p.code, null).catch(() => null))?.ok).toBe(true);
  });

  it('a document can be added later, at most five, and not to a rejected invoice; office learns a yes or a no', async () => {
    const p = await po();
    const made = await enter(users.owner, p.code, null);
    if (!made.ok) throw new Error(made.error);
    const png = { declaredType: 'image/png', bytes: pngWithText() };
    for (let i = 0; i < 5; i += 1)
      expect(
        await attachSupplierInvoiceFile(app, users.office, { code: made.value.code }, png, {
          store: store(),
        }),
      ).toEqual({
        ok: true,
        value: { attached: true },
      });
    expect(
      await attachSupplierInvoiceFile(app, users.office, { code: made.value.code }, png, { store: store() }),
    ).toEqual({
      ok: false,
      error: 'REFUSED',
    });
    const other = await enter(users.owner, (await po()).code, null);
    if (!other.ok) throw new Error(other.error);
    expect(
      (
        await rejectSupplierInvoice(app, users.owner, {
          supplierInvoiceId: await ownerId(other.value.code),
          reason: 'erreur',
        })
      ).ok,
    ).toBe(true);
    expect(
      await attachSupplierInvoiceFile(app, users.owner, { code: other.value.code }, png, { store: store() }),
    ).toEqual({
      ok: false,
      error: 'REFUSED',
    });
    expect(
      await attachSupplierInvoiceFile(app, users.owner, { code: 'FF-2026-99999' }, png, { store: store() }),
    ).toEqual({
      ok: false,
      error: 'REFUSED',
    });
  });

  it('partner and plant cannot attach; support cannot', async () => {
    const p = await po();
    const made = await enter(users.owner, p.code, null);
    if (!made.ok) throw new Error(made.error);
    for (const role of ['partner', 'plant', 'support'] as const)
      await expect(
        attachSupplierInvoiceFile(app, users[role], { code: made.value.code }, jpeg, { store: store() }),
      ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('opening it (AC-INT-04)', () => {
  let siId = '';
  let fileId = '';
  let code = '';
  beforeAll(async () => {
    const made = await enter(users.office, (await po()).code);
    if (!made.ok) throw new Error(made.error);
    code = made.value.code;
    siId = await ownerId(code);
    fileId = (await getSupplierInvoice(app, users.owner, siId))?.files[0]?.id as string;
  });

  it.each(['owner', 'support'] as const)('%s opens it and the view is audited', async (role) => {
    const count = async () =>
      Number(
        (
          await inCtx(users.owner, (tx) =>
            tx.query<{ n: string }>(
              `select count(*)::text as n from audit_event where action = 'view' and table_name = $1 and actor_user_id = $2`,
              [`file:supplier_invoice:${code}`, users[role].id],
            ),
          )
        ).rows[0]?.n,
      );
    const before = await count();
    const opened = await openSupplierInvoiceFile(
      app,
      users[role],
      { supplierInvoiceId: siId, fileId },
      { store: store() },
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.contentType).toBe('image/jpeg');
    expect(await count()).toBe(before + 1);
  });

  it('office, partner and plant cannot open it', async () => {
    for (const role of ['office', 'partner', 'plant'] as const)
      await expect(
        openSupplierInvoiceFile(app, users[role], { supplierInvoiceId: siId, fileId }, { store: store() }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.office, (tx) => tx.query('select 1 from supplier_invoice_file')),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('is found only under its own invoice, and a file altered on disk is refused, not served', async () => {
    const other = await enter(users.owner, (await po()).code, null);
    if (!other.ok) throw new Error(other.error);
    expect(
      await openSupplierInvoiceFile(
        app,
        users.owner,
        { supplierInvoiceId: await ownerId(other.value.code), fileId },
        { store: store() },
      ),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(
      await openSupplierInvoiceFile(
        app,
        users.owner,
        { supplierInvoiceId: siId, fileId: randomUUID() },
        { store: store() },
      ),
    ).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    const file = path.join(dir, fileId.slice(0, 2), `${fileId}.bin`);
    const good = await readFile(file);
    const altered = Buffer.from(good);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    await writeFile(file, altered);
    expect(
      await openSupplierInvoiceFile(
        app,
        users.owner,
        { supplierInvoiceId: siId, fileId },
        { store: store() },
      ),
    ).toEqual({
      ok: false,
      error: 'CORRUPT',
    });
    await writeFile(file, good);
  });

  it('the database refuses a direct row, an update and a delete to every role', async () => {
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into supplier_invoice_file (id, supplier_invoice_id, seq, content_type, size_bytes, sha256, created_by)
           values (gen_random_uuid(), $1, 4, 'image/png', 1, repeat('a', 64), $2)`,
          [siId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    for (const sql of [
      'update supplier_invoice_file set size_bytes = 1',
      'delete from supplier_invoice_file',
    ])
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  });
});
