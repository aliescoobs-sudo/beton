import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createClient,
  createSite,
  fieldCipherFrom,
  listSites,
  updateSite,
  type Client,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { ENCRYPTED_COLUMNS } from '../src/modules/platform-security/domain/encrypted-columns';
import {
  asSystemActor,
  countOnOldKeys,
  rotateColumn,
} from '../src/modules/platform-security/service/key-rotation';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(() => Promise.all([app.end(), system.end()]));

const keyring = parseKeyring(env.FIELD_ENCRYPTION_KEYS);
const deps = { cipher: fieldCipherFrom(keyring) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
let client: Client;
const unique = () => `Chantier ${Math.random().toString(36).slice(2, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  const created = await createClient(app, users.office, { name: unique(), kind: 'person' }, deps);
  if (!created.ok) throw new Error(created.error);
  client = created.value.client;
});

describe('client sites (master-data T4)', () => {
  it.each(['owner', 'partner', 'office'] as const)(
    '%s adds and edits a site; both are audited',
    async (role) => {
      const label = unique();
      const created = await createSite(
        app,
        users[role],
        client.id,
        { label, address: '12 rue Hassan II, Martil' },
        deps,
      );
      if (!created.ok) throw new Error(created.error);
      expect(created.value).toMatchObject({
        label,
        address: '12 rue Hassan II, Martil',
        clientId: client.id,
      });
      const updated = await updateSite(
        app,
        users[role],
        created.value.id,
        { label, address: 'Route de Tétouan' },
        deps,
      );
      expect(updated).toMatchObject({ ok: true, value: { address: 'Route de Tétouan' } });
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query<{ action: string }>(
          `select action from audit_event where table_name = 'client_site' and row_id = $1 order by id`,
          [created.value.id],
        ),
      );
      expect(rows.map((r) => r.action)).toEqual(['insert', 'update']);
      expect((await listSites(app, users[role], client.id, deps)).map((s) => s.label)).toContain(label);
    },
  );

  it('the address is encrypted at rest and an edit that keeps it keeps its ciphertext', async () => {
    const created = await createSite(
      app,
      users.office,
      client.id,
      { label: unique(), address: 'Lotissement Al Amal' },
      deps,
    );
    if (!created.ok) throw new Error(created.error);
    const sealed = () =>
      inCtx(users.owner, (tx) =>
        tx.query<{ address_enc: string }>('select address_enc from client_site where id = $1', [
          created.value.id,
        ]),
      ).then((r) => r.rows[0]!.address_enc);
    const before = await sealed();
    expect(before).toMatch(/^f1\./);
    expect(before).not.toContain('Amal');
    await updateSite(
      app,
      users.office,
      created.value.id,
      { label: created.value.label + ' 2', address: 'Lotissement Al Amal' },
      deps,
    );
    expect(await sealed()).toBe(before);
  });

  it('crypto:rotate covers the address column', async () => {
    const spec = ENCRYPTED_COLUMNS.find((c) => c.table === 'client_site' && c.column === 'address_enc')!;
    expect(spec).toMatchObject({ keyring: 'FIELD_ENCRYPTION_KEYS', pool: 'system' });
    const created = await createSite(
      app,
      users.office,
      client.id,
      { label: unique(), address: 'Quartier Jbel' },
      deps,
    );
    if (!created.ok) throw new Error(created.error);
    const k9 = `k9:${Buffer.alloc(32, 9).toString('base64')}`;
    const next = parseKeyring(`${k9},${env.FIELD_ENCRYPTION_KEYS}`);
    const queryable = asSystemActor(system);
    try {
      await rotateColumn(queryable, spec, next);
      expect(await countOnOldKeys(queryable, spec, next)).toBe(0);
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query<{ address_enc: string }>('select address_enc from client_site where id = $1', [
          created.value.id,
        ]),
      );
      expect(next.decrypt(rows[0]!.address_enc)).toBe('Quartier Jbel');
    } finally {
      await rotateColumn(queryable, spec, parseKeyring(`${env.FIELD_ENCRYPTION_KEYS},${k9}`));
    }
  });

  it('plant is refused by the service and sees nothing under RLS', async () => {
    await expect(createSite(app, users.plant, client.id, { label: unique() }, deps)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listSites(app, users.plant, client.id, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await inCtx(users.plant, (tx) => tx.query('select id from client_site'))).rows).toEqual([]);
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(`insert into client_site (id, client_id, label) values (gen_random_uuid(), $1, 'x')`, [
          client.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a duplicate label per client (any case), invalid input and an unknown client', async () => {
    const label = unique();
    expect((await createSite(app, users.office, client.id, { label }, deps)).ok).toBe(true);
    expect(await createSite(app, users.office, client.id, { label: label.toUpperCase() }, deps)).toEqual({
      ok: false,
      error: 'DUPLICATE_LABEL',
    });
    expect(await createSite(app, users.office, client.id, { label: '' }, deps)).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await createSite(app, users.office, crypto.randomUUID(), { label: unique() }, deps)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await updateSite(app, users.office, 'nope', { label: unique() }, deps)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('a site cannot move to another client, and nobody can delete one', async () => {
    const created = await createSite(app, users.office, client.id, { label: unique() }, deps);
    if (!created.ok) throw new Error(created.error);
    const other = await createClient(app, users.office, { name: unique(), kind: 'person' }, deps);
    if (!other.ok) throw new Error(other.error);
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query('update client_site set client_id = $1 where id = $2', [
          other.value.client.id,
          created.value.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23000' });
    await expect(inCtx(users.owner, (tx) => tx.query('delete from client_site'))).rejects.toMatchObject({
      code: '42501',
    });
  });
});
