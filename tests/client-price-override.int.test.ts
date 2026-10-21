import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createClient,
  createClientOverride,
  createConcreteType,
  createListPrice,
  fieldCipherFrom,
  listSellingPrices,
  resolveSellingPriceFor,
  type Client,
  type ConcreteType,
} from '../src/modules/master-data';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { archiveClient } from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { realSessionUser } from './helpers/actors';
import { testEnv } from './db-env';

// AC-MD-03 (override beats list) and AC-MD-10 (managers only, mandatory reason, audited).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const rand = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function newType(): Promise<ConcreteType> {
  const r = await createConcreteType(app, users.owner, { code: `O${rand()}`, label: 'Béton override' });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function newClient(): Promise<Client> {
  const r = await createClient(app, users.office, { name: `Client ${rand()}`, kind: 'company' }, deps);
  if (!r.ok) throw new Error(r.error);
  return r.value.client;
}

const override = (
  concreteTypeId: string,
  clientId: string,
  priceHtPerM3Centimes: number,
  effectiveFrom: string,
  reason: unknown = 'Gros chantier',
) => ({ concreteTypeId, clientId, priceHtPerM3Centimes, effectiveFrom, reason });

describe('per-client price override (master-data T12, AC-MD-03, AC-MD-10)', () => {
  it.each(['owner', 'partner'] as const)('%s saves an override that beats the list price', async (role) => {
    const type = await newType();
    const client = await newClient();
    const other = await newClient();
    await createListPrice(app, users.owner, {
      concreteTypeId: type.id,
      priceHtPerM3Centimes: 95_000,
      effectiveFrom: '2026-01-01',
    });
    const made = await createClientOverride(
      app,
      users[role],
      override(type.id, client.id, 85_000, '2026-02-01'),
    );
    if (!made.ok) throw new Error(made.error);
    expect(made.value).toMatchObject({ clientId: client.id, reason: 'Gros chantier' });

    expect(await resolveSellingPriceFor(app, users.office, type.id, client.id, '2026-03-01')).toMatchObject({
      ok: true,
      value: { id: made.value.id, priceHtPerM3Centimes: 85_000 },
    });
    // Before the override starts, and for another client: the list price.
    expect(await resolveSellingPriceFor(app, users.office, type.id, client.id, '2026-01-15')).toMatchObject({
      ok: true,
      value: { clientId: null, priceHtPerM3Centimes: 95_000 },
    });
    expect(await resolveSellingPriceFor(app, users.office, type.id, other.id, '2026-03-01')).toMatchObject({
      ok: true,
      value: { clientId: null },
    });
  });

  it('an override with no list price still resolves for that client only; nobody else gets a price', async () => {
    const type = await newType();
    const client = await newClient();
    const other = await newClient();
    await createClientOverride(app, users.owner, override(type.id, client.id, 80_000, '2026-02-01'));
    expect(await resolveSellingPriceFor(app, users.owner, type.id, client.id, '2026-03-01')).toMatchObject({
      ok: true,
    });
    expect(await resolveSellingPriceFor(app, users.owner, type.id, other.id, '2026-03-01')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
  });

  it('versions by effective_from per client and type', async () => {
    const type = await newType();
    const client = await newClient();
    await createClientOverride(app, users.owner, override(type.id, client.id, 80_000, '2026-02-01'));
    expect(
      (await createClientOverride(app, users.owner, override(type.id, client.id, 78_000, '2026-06-01'))).ok,
    ).toBe(true);
    for (const date of ['2026-06-01', '2026-01-01']) {
      expect(
        await createClientOverride(app, users.owner, override(type.id, client.id, 70_000, date)),
      ).toEqual({
        ok: false,
        error: 'NOT_AFTER_LATEST',
      });
    }
    expect(await resolveSellingPriceFor(app, users.owner, type.id, client.id, '2026-05-31')).toMatchObject({
      value: { priceHtPerM3Centimes: 80_000 },
    });
    expect(await resolveSellingPriceFor(app, users.owner, type.id, client.id, '2026-06-01')).toMatchObject({
      value: { priceHtPerM3Centimes: 78_000 },
    });
  });

  it.each(['office', 'plant'] as const)(
    '%s is refused by the service and by direct SQL under RLS',
    async (role) => {
      const type = await newType();
      const client = await newClient();
      await expect(
        createClientOverride(app, users[role], override(type.id, client.id, 80_000, '2026-02-01')),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, reason, created_by)
           values (gen_random_uuid(), $1, $2, 80000, '2026-02-01', 'je veux', $3)`,
            [type.id, client.id, users[role].id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query(
          `select 1 from audit_event where action = 'permission_denied' and reason = 'client_price_override.write' and actor_user_id = $1`,
          [users[role].id],
        ),
      );
      expect(rows.length).toBeGreaterThan(0);
    },
  );

  it.each([undefined, '', '   '])(
    'owner/partner without a reason (%j) is refused by the service',
    async (reason) => {
      const type = await newType();
      const client = await newClient();
      expect(
        await createClientOverride(app, users.owner, {
          ...override(type.id, client.id, 80_000, '2026-02-01'),
          reason,
        }),
      ).toEqual({
        ok: false,
        error: 'INVALID',
      });
      expect(await listSellingPrices(app, users.owner, { clientId: client.id })).toEqual([]);
    },
  );

  it('a client row with no reason is refused by the CHECK, and one with a blank reason by the column CHECK', async () => {
    const type = await newType();
    const client = await newClient();
    for (const reason of [null, '', '  ']) {
      await expect(
        inCtx(users.owner, (tx) =>
          tx.query(
            `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, reason, created_by)
             values (gen_random_uuid(), $1, $2, 80000, '2026-02-01', $3, $4)`,
            [type.id, client.id, reason, users.owner.id],
          ),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) });
    }
    // The CHECK itself, past the policy: the owner of the table is exempt from RLS once FORCE is lifted (rolled back).
    const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
    const c = await migrator.connect();
    try {
      await c.query('begin');
      await c.query('alter table selling_price no force row level security');
      await expect(
        c.query(
          `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
           values (gen_random_uuid(), $1, $2, 80000, '2026-02-01', $3)`,
          [type.id, client.id, users.owner.id],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'selling_price_override_needs_reason' });
    } finally {
      await c.query('rollback');
      c.release();
      await migrator.end();
    }
  });

  it('saves with one audit event carrying the reason in `after`', async () => {
    const type = await newType();
    const client = await newClient();
    const made = await createClientOverride(
      app,
      users.partner,
      override(type.id, client.id, 80_000, '2026-02-01', 'Accord cadre 2026'),
    );
    if (!made.ok) throw new Error(made.error);
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query<{ action: string; after: Record<string, unknown> }>(
        `select action, after from audit_event where table_name = 'selling_price' and row_id = $1 and action <> 'permission_denied'`,
        [made.value.id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({ reason: 'Accord cadre 2026', client_id: client.id });
  });

  it('refuses an archived client and an unknown client', async () => {
    const type = await newType();
    const client = await newClient();
    await archiveClient(app, users.owner, client.id);
    expect(
      await createClientOverride(app, users.owner, override(type.id, client.id, 80_000, '2026-02-01')),
    ).toEqual({
      ok: false,
      error: 'INACTIVE',
    });
    expect(
      await createClientOverride(
        app,
        users.owner,
        override(type.id, '019c0000-0000-7000-8000-0000000000ff', 80_000, '2026-02-01'),
      ),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});
