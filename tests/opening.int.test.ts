import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { addPartyOpeningBalance, enterOpeningDate, getOpeningState } from '../src/modules/ledger';
import { archiveClient, createClient, fieldCipherFrom } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { moneyMaster } from './helpers/ledger-fixtures';

// ledger L33: the opening state. The opening date is a singleton shared by the test database.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `opn${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

const newClient = async () => {
  const c = await createClient(
    app,
    users.office,
    { name: `Client ouverture ${randomUUID()}`, kind: 'company' },
    deps,
  );
  if (!c.ok) throw new Error(c.error);
  return c.value.client.id;
};

describe('the opening date', () => {
  it('is entered once; a second entry is refused', async () => {
    const first = await enterOpeningDate(app, users.owner, { openingDate: '2026-01-01' });
    expect([true, false]).toContain(first.ok); // another suite may have entered it already
    if (!first.ok) expect(first.error).toBe('ALREADY_ENTERED');
    expect(await enterOpeningDate(app, users.owner, { openingDate: '2026-02-01' })).toEqual({
      ok: false,
      error: 'ALREADY_ENTERED',
    });
    expect((await getOpeningState(app, users.owner)).openingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses an impossible date', async () => {
    expect(await enterOpeningDate(app, users.owner, { openingDate: '2026-02-30' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it.each(['office', 'partner', 'plant', 'support'] as const)('%s cannot enter it', async (role) => {
    await expect(enterOpeningDate(app, users[role], { openingDate: '2026-01-01' })).rejects.toThrow();
    await expect(
      inCtx(users[role], (tx) =>
        tx.query(`insert into ledger_opening (opening_date, created_by) values ('2026-01-01', $1)`, [
          users[role].id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('party opening balances', () => {
  it('records what a client owes and what we owe a supplier, once per party, and reads them back', async () => {
    await enterOpeningDate(app, users.owner, { openingDate: '2026-01-01' });
    const clientId = await newClient();
    const supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
    expect(
      (
        await addPartyOpeningBalance(app, users.owner, {
          clientId,
          amountCentimes: 1_250_000,
          reference: 'Solde repris',
        })
      ).ok,
    ).toBe(true);
    expect((await addPartyOpeningBalance(app, users.owner, { supplierId, amountCentimes: 400_000 })).ok).toBe(
      true,
    );
    expect(await addPartyOpeningBalance(app, users.owner, { clientId, amountCentimes: 1 })).toEqual({
      ok: false,
      error: 'DUPLICATE',
    });
    for (const role of ['owner', 'support'] as const) {
      const state = await getOpeningState(app, users[role]);
      expect(state.parties.find((p) => p.partyId === clientId)).toMatchObject({
        kind: 'client',
        amountCentimes: 1_250_000,
        reference: 'Solde repris',
      });
      expect(state.parties.find((p) => p.partyId === supplierId)).toMatchObject({
        kind: 'supplier',
        amountCentimes: 400_000,
      });
    }
  });

  it('refuses nothing owed, both parties at once, none, an archived client and an unknown one', async () => {
    const clientId = await newClient();
    const supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
    expect(await addPartyOpeningBalance(app, users.owner, { clientId, amountCentimes: 0 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await addPartyOpeningBalance(app, users.owner, { clientId, supplierId, amountCentimes: 5 }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(await addPartyOpeningBalance(app, users.owner, { amountCentimes: 5 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await addPartyOpeningBalance(app, users.owner, { clientId: randomUUID(), amountCentimes: 5 }),
    ).toEqual({ ok: false, error: 'PARTY_ARCHIVED' });
    expect(await archiveClient(app, users.owner, clientId)).toEqual({ ok: true, value: true });
    expect(await addPartyOpeningBalance(app, users.owner, { clientId, amountCentimes: 5 })).toEqual({
      ok: false,
      error: 'PARTY_ARCHIVED',
    });
  });

  it.each(['office', 'partner', 'plant', 'support'] as const)(
    '%s cannot write; office, partner and plant read nothing',
    async (role) => {
      const clientId = await newClient();
      await expect(
        addPartyOpeningBalance(app, users[role], { clientId, amountCentimes: 5 }),
      ).rejects.toThrow();
      if (role !== 'support') {
        await expect(getOpeningState(app, users[role])).rejects.toThrow();
        expect(
          (await inCtx(users[role], (tx) => tx.query('select 1 from opening_party_balance'))).rows,
        ).toEqual([]);
        expect((await inCtx(users[role], (tx) => tx.query('select 1 from ledger_opening'))).rows).toEqual([]);
      }
    },
  );

  it('nothing is edited or deleted, not even by the owner', async () => {
    for (const sql of [
      'update ledger_opening set opening_date = now()::date',
      'delete from ledger_opening',
      'update opening_party_balance set amount_centimes = 1',
      'delete from opening_party_balance',
    ])
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  });
});
