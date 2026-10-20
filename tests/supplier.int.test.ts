import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  archiveSupplier,
  createSupplier,
  fieldCipherFrom,
  listSuppliers,
  updateSupplier,
  type Supplier,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const unique = () => `Fournisseur ${Math.random().toString(36).slice(2, 10)}`;
const ice = () => Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function create(user: SessionUser, extra: Record<string, unknown> = {}): Promise<Supplier> {
  const result = await createSupplier(app, user, { name: unique(), category: 'cement', ...extra }, deps);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('suppliers (master-data T5)', () => {
  it.each(['owner', 'partner', 'office'] as const)(
    '%s creates and edits a supplier; both audited',
    async (role) => {
      const supplier = await create(users[role]);
      expect(supplier.code).toMatch(/^FRN-\d{2,}$/);
      const updated = await updateSupplier(
        app,
        users[role],
        supplier.id,
        { name: supplier.name, category: 'fuel', paymentTermsDays: 45 },
        deps,
      );
      expect(updated).toMatchObject({ ok: true, value: { category: 'fuel', paymentTermsDays: 45 } });
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query<{ action: string }>(
          `select action from audit_event where table_name = 'supplier' and row_id = $1 order by id`,
          [supplier.id],
        ),
      );
      expect(rows.map((r) => r.action)).toEqual(['insert', 'update']);
    },
  );

  it('seals the phone; a raw SELECT shows ciphertext', async () => {
    const supplier = await create(users.office, { phone: '0539 12 34 56' });
    expect(supplier.phone).toBe('0539 12 34 56');
    const { rows } = await inCtx(users.office, (tx) =>
      tx.query<{ phone_enc: string }>('select phone_enc from supplier where id = $1', [supplier.id]),
    );
    expect(rows[0]!.phone_enc).toMatch(/^f1\./);
    expect(rows[0]!.phone_enc).not.toContain('1234');
  });

  it('the code is immutable (trigger), also for the owner', async () => {
    const supplier = await create(users.office);
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(`update supplier set code = 'FRN-99' where id = $1`, [supplier.id]),
      ),
    ).rejects.toMatchObject({ code: '23000' });
  });

  it('office cannot archive (service audited, database refuses); owner and partner can, audited', async () => {
    const supplier = await create(users.office);
    await expect(archiveSupplier(app, users.office, supplier.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(`update supplier set status = 'archived' where id = $1`, [supplier.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await archiveSupplier(app, users.partner, supplier.id)).toEqual({ ok: true, value: true });
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query<{ action: string }>(
        `select action from audit_event where table_name = 'supplier' and row_id = $1 order by id`,
        [supplier.id],
      ),
    );
    expect(rows.map((r) => r.action)).toEqual(['insert', 'update', 'archive']);
    expect((await listSuppliers(app, users.office, deps)).find((s) => s.id === supplier.id)?.status).toBe(
      'archived',
    );
    expect(await archiveSupplier(app, users.owner, supplier.id)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('plant is refused by the service and sees nothing under RLS', async () => {
    await expect(listSuppliers(app, users.plant, deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createSupplier(app, users.plant, { name: unique(), category: 'fuel' }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await inCtx(users.plant, (tx) => tx.query('select id from supplier'))).rows).toEqual([]);
  });

  it('refuses a duplicate ICE, a bad category and a malformed ICE', async () => {
    const taken = ice();
    await create(users.office, { ice: taken });
    expect(
      await createSupplier(app, users.office, { name: unique(), category: 'fuel', ice: taken }, deps),
    ).toEqual({
      ok: false,
      error: 'DUPLICATE_ICE',
    });
    expect(await createSupplier(app, users.office, { name: unique(), category: 'beer' }, deps)).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await createSupplier(app, users.office, { name: unique(), category: 'fuel', ice: '12' }, deps),
    ).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('nobody can delete or truncate suppliers', async () => {
    await expect(inCtx(users.owner, (tx) => tx.query('delete from supplier'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.query('truncate supplier')).rejects.toMatchObject({ code: '42501' });
  });
});
