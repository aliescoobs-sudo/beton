import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  archiveClient,
  createClient,
  fieldCipherFrom,
  listClients,
  listSelectableClients,
  updateClient,
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
beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

const rand = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const uniqueIce = () => rand(15);
const uniqueName = () => `Client ${Math.random().toString(36).slice(2, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);

async function create(user: SessionUser, input: Record<string, unknown>): Promise<Client> {
  const result = await createClient(app, user, input, deps);
  if (!result.ok) throw new Error(result.error);
  return result.value.client;
}

async function events(rowId: string) {
  const { rows } = await inCtx(users.owner, (tx) =>
    tx.query<{ action: string; after: Record<string, unknown> | null }>(
      `select action, after from audit_event where table_name = 'client' and row_id = $1 and action <> 'permission_denied' order by id`,
      [rowId],
    ),
  );
  return rows;
}

describe('creating clients (AC-MD-01)', () => {
  it.each(['owner', 'partner', 'office'] as const)(
    '%s creates a client from a name and a kind alone',
    async (role) => {
      const client = await create(users[role], { name: uniqueName(), kind: 'person' });
      expect(client).toMatchObject({ kind: 'person', ice: null, status: 'active', paymentTermsDays: 60 });
      expect(client.code).toMatch(/^CLT-\d{3,}$/);
    },
  );

  it('generates increasing codes and never changes one', async () => {
    const a = await create(users.office, { name: uniqueName(), kind: 'person' });
    const b = await create(users.office, { name: uniqueName(), kind: 'person' });
    expect(Number(b.code.slice(4))).toBeGreaterThan(Number(a.code.slice(4)));
    await expect(
      inCtx(users.owner, (tx) => tx.query(`update client set code = 'CLT-999' where id = $1`, [a.id])),
    ).rejects.toMatchObject({
      code: '23000',
    });
  });

  it('plant is refused by the service (audited) and by RLS', async () => {
    await expect(
      createClient(app, users.plant, { name: uniqueName(), kind: 'person' }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listClients(app, users.plant, deps)).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await inCtx(users.plant, (tx) => tx.query('select id from client'));
    expect(rows).toEqual([]);
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into client (id, code, name, kind) values (gen_random_uuid(), 'CLT-998', 'X', 'person')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses invalid input', async () => {
    expect(await createClient(app, users.office, { name: '', kind: 'person' }, deps)).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await createClient(app, users.office, { name: uniqueName(), kind: 'company', ice: '12' }, deps),
    ).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await createClient(
        app,
        users.office,
        { name: uniqueName(), kind: 'person', defaultZoneId: crypto.randomUUID() },
        deps,
      ),
    ).toEqual({ ok: false, error: 'INVALID' });
  });

  it('warns about a similar name but saves the client', async () => {
    const first = await create(users.office, { name: `Société Atlas ${rand(6)}`, kind: 'company' });
    const second = await createClient(
      app,
      users.office,
      { name: first.name.toUpperCase().replace('É', 'E'), kind: 'company' },
      deps,
    );
    expect(second).toMatchObject({
      ok: true,
      value: { similar: [expect.objectContaining({ id: first.id })] },
    });
  });
});

describe('phone is sealed (AC-MD-01 data part)', () => {
  it('a raw SELECT shows ciphertext only; the service shows the number', async () => {
    const client = await create(users.office, {
      name: uniqueName(),
      kind: 'person',
      phone: '+212 500-000456',
    });
    expect(client.phone).toBe('+212 500-000456');
    const { rows } = await inCtx(users.office, (tx) =>
      tx.query<{ phone_enc: string }>('select phone_enc from client where id = $1', [client.id]),
    );
    expect(rows[0]!.phone_enc).toMatch(/^f1\./);
    expect(rows[0]!.phone_enc).not.toContain('600');
    const listed = (await listClients(app, users.office, deps)).find((c) => c.id === client.id);
    expect(listed?.phone).toBe('+212 500-000456');
  });

  it('an edit that does not touch the phone leaves its ciphertext as it was', async () => {
    const client = await create(users.office, { name: uniqueName(), kind: 'person', phone: '0500000456' });
    const sealed = () =>
      inCtx(users.owner, (tx) =>
        tx.query<{ phone_enc: string }>('select phone_enc from client where id = $1', [client.id]),
      ).then((r) => r.rows[0]!.phone_enc);
    const before = await sealed();
    await updateClient(
      app,
      users.office,
      client.id,
      { name: client.name, kind: 'person', phone: '0500000456', notes: 'x' },
      deps,
    );
    expect(await sealed()).toBe(before);
  });

  it('crypto:rotate moves it to a new key as the system actor', async () => {
    const client = await create(users.office, { name: uniqueName(), kind: 'person', phone: '0500000011' });
    const spec = ENCRYPTED_COLUMNS.find((c) => c.table === 'client' && c.column === 'phone_enc')!;
    expect(spec.pool).toBe('system');
    const k9 = `k9:${Buffer.alloc(32, 9).toString('base64')}`;
    const next = parseKeyring(`${k9},${env.FIELD_ENCRYPTION_KEYS}`);
    const queryable = asSystemActor(system);
    try {
      expect(await countOnOldKeys(queryable, spec, next)).toBeGreaterThan(0);
      await rotateColumn(queryable, spec, next);
      expect(await countOnOldKeys(queryable, spec, next)).toBe(0);
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query<{ phone_enc: string }>('select phone_enc from client where id = $1', [client.id]),
      );
      expect(rows[0]!.phone_enc).toMatch(/^f1\.k9\./);
      expect(next.decrypt(rows[0]!.phone_enc)).toBe('0500000011');
    } finally {
      // Put every row back on the configured key (k9 stays decryptable) so the other tests read their phones.
      await rotateColumn(queryable, spec, parseKeyring(`${env.FIELD_ENCRYPTION_KEYS},${k9}`));
    }
  });

  it('the system role can update nothing but the phone', async () => {
    await expect(
      withRlsContext(system, { userId: users.owner.id, role: 'system', requestId: 'test' }, (tx) =>
        tx.query(`update client set name = 'x'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('ICE duplicate guard', () => {
  it('blocks a matching ICE for office, whatever the formatting, and nothing is created', async () => {
    const ice = uniqueIce();
    const existing = await create(users.office, { name: uniqueName(), kind: 'company', ice });
    const before = (await listClients(app, users.office, deps)).length;
    const spaced = `${ice.slice(0, 5)} ${ice.slice(5, 10)}-${ice.slice(10)}`;
    expect(
      await createClient(app, users.office, { name: uniqueName(), kind: 'company', ice: spaced }, deps),
    ).toEqual({
      ok: false,
      error: 'DUPLICATE_ICE',
    });
    expect((await listClients(app, users.office, deps)).length).toBe(before);
    expect(existing.ice).toBe(ice);
  });

  it('refuses an office override reason (audited) and the database refuses it too', async () => {
    const ice = uniqueIce();
    await create(users.office, { name: uniqueName(), kind: 'company', ice });
    await expect(
      createClient(
        app,
        users.office,
        { name: uniqueName(), kind: 'company', ice, iceOverrideReason: 'je suis sûr' },
        deps,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await inCtx(users.office, (tx) =>
      tx.query(
        `select 1 from audit_event where action = 'permission_denied' and reason = 'parties.ice_override'`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(
          `insert into client (id, code, name, kind, ice, ice_override_reason) values (gen_random_uuid(), 'CLT-997', 'X', 'company', $1, 'because')`,
          [ice],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['owner', 'partner'] as const)(
    '%s overrides with a reason; the reason is audited with the client',
    async (role) => {
      const ice = uniqueIce();
      const first = await create(users.office, { name: uniqueName(), kind: 'company', ice });
      const second = await create(users[role], {
        name: uniqueName(),
        kind: 'company',
        ice,
        iceOverrideReason: 'Deux sociétés du même groupe',
      });
      expect(second.id).not.toBe(first.id);
      expect(second.iceOverrideReason).toBe('Deux sociétés du même groupe');
      expect(await events(second.id)).toEqual([
        expect.objectContaining({
          action: 'insert',
          after: expect.objectContaining({ ice_override_reason: 'Deux sociétés du même groupe' }),
        }),
      ]);
      // The reason is mandatory: too short is refused, none is a block.
      expect(
        await createClient(
          app,
          users[role],
          { name: uniqueName(), kind: 'company', ice, iceOverrideReason: 'x' },
          deps,
        ),
      ).toEqual({
        ok: false,
        error: 'INVALID',
      });
    },
  );

  it('editing the ICE to an existing one is guarded the same way', async () => {
    const ice = uniqueIce();
    await create(users.office, { name: uniqueName(), kind: 'company', ice });
    const other = await create(users.office, { name: uniqueName(), kind: 'company', ice: uniqueIce() });
    const input = { name: other.name, kind: 'company', ice };
    expect(await updateClient(app, users.office, other.id, input, deps)).toEqual({
      ok: false,
      error: 'DUPLICATE_ICE',
    });
    expect(
      await updateClient(app, users.owner, other.id, { ...input, iceOverrideReason: 'Filiale' }, deps),
    ).toMatchObject({
      ok: true,
      value: { client: { iceOverrideReason: 'Filiale' } },
    });
    // Office cannot quietly drop an override either.
    await expect(
      updateClient(
        app,
        users.office,
        other.id,
        { name: other.name, kind: 'company', ice: uniqueIce() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the database itself keeps two plain clients from sharing an ICE', async () => {
    const ice = uniqueIce();
    await create(users.office, { name: uniqueName(), kind: 'company', ice });
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(
          `insert into client (id, code, name, kind, ice) values (gen_random_uuid(), public.next_code('CLT', 3), 'Dup', 'company', $1)`,
          [ice],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('editing and archiving', () => {
  it('office edits a client; the change is audited', async () => {
    const client = await create(users.office, { name: uniqueName(), kind: 'person' });
    const result = await updateClient(
      app,
      users.office,
      client.id,
      { name: client.name, kind: 'person', paymentTermsDays: 90, notes: 'Paie le 5' },
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { client: { paymentTermsDays: 90, notes: 'Paie le 5' } },
    });
    expect((await events(client.id)).map((e) => e.action)).toEqual(['insert', 'update']);
    expect(
      await updateClient(
        app,
        users.office,
        '019c0000-0000-7000-8000-0000000000ff',
        { name: 'A', kind: 'person' },
        deps,
      ),
    ).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await updateClient(app, users.office, 'nope', { name: 'A', kind: 'person' }, deps)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('office cannot archive: service refuses (audited), and the database refuses a direct update', async () => {
    const client = await create(users.office, { name: uniqueName(), kind: 'person' });
    await expect(archiveClient(app, users.office, client.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(`update client set status = 'archived' where id = $1`, [client.id]),
      ),
    ).rejects.toMatchObject({
      code: '42501',
    });
    const { rows } = await inCtx(users.office, (tx) =>
      tx.query(`select 1 from audit_event where action = 'permission_denied' and reason = 'parties.archive'`),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(['owner', 'partner'] as const)(
    '%s archives: audited, not selectable any more, still readable (AC-MD-05)',
    async (role) => {
      const client = await create(users.office, { name: uniqueName(), kind: 'person' });
      expect(await archiveClient(app, users[role], client.id)).toEqual({ ok: true, value: true });
      expect((await events(client.id)).map((e) => e.action)).toEqual(['insert', 'update', 'archive']);
      expect((await listSelectableClients(app, users.office, deps)).map((c) => c.id)).not.toContain(
        client.id,
      );
      const listed = (await listClients(app, users.office, deps)).find((c) => c.id === client.id);
      expect(listed?.status).toBe('archived');
      expect(await archiveClient(app, users[role], client.id)).toEqual({ ok: false, error: 'NOT_FOUND' });
    },
  );
});

describe('no hard deletes, no CIN (AC-MD-06, AC-MD-01)', () => {
  it('nobody can delete or truncate clients or counters', async () => {
    for (const table of ['client', 'code_sequence']) {
      await expect(inCtx(users.owner, (tx) => tx.query(`delete from ${table}`))).rejects.toMatchObject({
        code: '42501',
      });
      await expect(app.query(`truncate ${table}`)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the client table has no CIN-like column', async () => {
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'client'`,
      ),
    );
    expect(rows.map((r) => r.column_name).filter((c) => /cin|national|identity/i.test(c))).toEqual([]);
  });
});
