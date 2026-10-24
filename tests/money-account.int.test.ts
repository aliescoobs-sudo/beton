import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createMoneyAccount, listMoneyAccounts, setOpeningBalance } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L8: caisse and bank accounts with opening balances (AC-SEC-04 for both tables lives in tests/rls).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `acct${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

describe('money accounts', () => {
  it('the owner creates a caisse and a bank account; owner and support list them with the opening balance', async () => {
    const cash = await createMoneyAccount(app, users.owner, { kind: 'cash', label: `Caisse ${marker}` });
    const bank = await createMoneyAccount(app, users.owner, {
      kind: 'bank',
      label: `Compte ${marker}`,
      bankName: 'Banque fictive',
    });
    expect(cash.ok && bank.ok).toBe(true);
    if (!cash.ok || !bank.ok) return;
    expect(
      (
        await setOpeningBalance(app, users.owner, {
          accountId: cash.value.id,
          asOf: '2026-01-01',
          amountCentimes: 250_000,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await setOpeningBalance(app, users.owner, {
          accountId: bank.value.id,
          asOf: '2026-01-01',
          amountCentimes: -1_200_000,
          note: 'découvert',
        })
      ).ok,
    ).toBe(true);
    for (const role of ['owner', 'support'] as const) {
      const accounts = (await listMoneyAccounts(app, users[role])).filter((a) => a.label.endsWith(marker));
      expect(accounts.map((a) => [a.kind, a.opening?.amountCentimes])).toEqual([
        ['cash', 250_000],
        ['bank', -1_200_000],
      ]);
    }
  });

  it('refuses a second account with the same label (case-insensitive) and a second opening balance', async () => {
    const first = await createMoneyAccount(app, users.owner, { kind: 'cash', label: `Dup ${marker}` });
    expect(await createMoneyAccount(app, users.owner, { kind: 'cash', label: `dup ${marker}` })).toEqual({
      ok: false,
      error: 'DUPLICATE',
    });
    if (!first.ok) throw new Error('setup');
    const body = { accountId: first.value.id, asOf: '2026-01-01', amountCentimes: 1 };
    expect((await setOpeningBalance(app, users.owner, body)).ok).toBe(true);
    expect(await setOpeningBalance(app, users.owner, body)).toEqual({ ok: false, error: 'DUPLICATE' });
  });

  it('refuses an unknown account, a fraction and a bank account without a bank', async () => {
    expect(
      await setOpeningBalance(app, users.owner, {
        accountId: randomUUID(),
        asOf: '2026-01-01',
        amountCentimes: 1,
      }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(
      await setOpeningBalance(app, users.owner, {
        accountId: randomUUID(),
        asOf: '2026-01-01',
        amountCentimes: 1.5,
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(await createMoneyAccount(app, users.owner, { kind: 'bank', label: `B ${marker}` })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it.each(['office', 'partner', 'plant', 'support'] as const)(
    '%s cannot create an account or set a balance',
    async (role) => {
      await expect(
        createMoneyAccount(app, users[role], { kind: 'cash', label: `X ${role} ${marker}` }),
      ).rejects.toThrow();
      await expect(
        setOpeningBalance(app, users[role], {
          accountId: randomUUID(),
          asOf: '2026-01-01',
          amountCentimes: 1,
        }),
      ).rejects.toThrow();
    },
  );

  it.each(['office', 'partner', 'plant'] as const)('%s cannot list the accounts', async (role) => {
    await expect(listMoneyAccounts(app, users[role])).rejects.toThrow();
  });

  it('nobody can edit or delete an account or a balance, even with direct SQL as the owner', async () => {
    for (const sql of [
      `update money_account set label = 'x'`,
      `delete from money_account`,
      `update opening_balance set amount_centimes = 0`,
      `delete from opening_balance`,
    ]) {
      await expect(
        withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
          tx.query(sql),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});
