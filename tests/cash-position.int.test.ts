import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  clearInstrument,
  createMoneyAccount,
  getCashPosition,
  issueInstrument,
  receiveInstrument,
  reverseMovement,
  setOpeningBalance,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { expectNoFields } from './helpers/expect-no-fields';
import { realSessionUser } from './helpers/actors';
import { moneyMaster, orderMaster } from './helpers/ledger-fixtures';

// ledger L16: encaissé vs total (AC-LED-07), owner and support only (AC-SEC-05).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `cash${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';
let clientId: string;
let supplierId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  clientId = (await orderMaster(app, users.owner.id, marker)).clientId;
  supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
});

const bank = async (opening: number) => {
  const a = await createMoneyAccount(app, users.owner, {
    kind: 'bank',
    label: `Cash ${marker} ${randomUUID().slice(0, 6)}`,
    bankName: 'Banque fictive',
  });
  if (!a.ok) throw new Error(a.error);
  expect(
    (
      await setOpeningBalance(app, users.owner, {
        accountId: a.value.id,
        asOf: '2026-01-01',
        amountCentimes: opening,
      })
    ).ok,
  ).toBe(true);
  return a.value.id;
};
const cheque = (amount: number, extra: Record<string, unknown> = {}) => ({
  method: 'cheque',
  amountCentimes: amount,
  number: `Q${randomUUID().replace(/-/g, '').slice(0, 9)}`,
  bank: 'B',
  writtenDate: TODAY,
  ...extra,
});
const deposit = (instrumentId: string, accountId: string) =>
  inCtx(users.owner, (tx) =>
    tx.query(
      `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, created_by) values (gen_random_uuid(), $1, 'deposited', $2, $3, $4)`,
      [instrumentId, TODAY, accountId, users.owner.id],
    ),
  );

describe('getCashPosition', () => {
  it('real = opening + cleared movements; total adds what is received or deposited; per account and in total', async () => {
    const accountId = await bank(1_000_000);
    const before = await getCashPosition(app, users.owner);

    const a = await receiveInstrument(app, users.office, cheque(500_000, { clientId }), { today: TODAY });
    const b = await receiveInstrument(app, users.office, cheque(200_000, { clientId }), { today: TODAY });
    const c = await receiveInstrument(app, users.office, cheque(40_000, { clientId }), { today: TODAY });
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup');
    await deposit(a.value.id, accountId);
    await deposit(c.value.id, accountId);
    await clearInstrument(app, users.owner, { instrumentId: c.value.id, accountId, date: '2026-06-02' });
    const out = await issueInstrument(
      app,
      users.office,
      { method: 'transfer', amountCentimes: 90_000, supplierId },
      { today: TODAY },
    );
    if (!out.ok) throw new Error('setup');

    const own = await getCashPosition(app, users.owner, accountId);
    expect(own.real).toBe(1_040_000);
    expect(own.incomingUncleared).toBe(500_000);
    expect(own.total).toBe(1_540_000);
    expect(own.accounts[0]).toMatchObject({
      opening: 1_000_000,
      movements: 40_000,
      incomingDeposited: 500_000,
    });

    const after = await getCashPosition(app, users.owner);
    // The account (opening 10 000,00) existed before. b was only received (no account yet), a is deposited, c cleared (+40 000 real); the transfer is issued, not cleared.
    expect(Number(after.real) - Number(before.real)).toBe(40_000);
    expect(Number(after.incomingUncleared) - Number(before.incomingUncleared)).toBe(700_000);
    expect(Number(after.total) - Number(before.total)).toBe(740_000);
    expect(Number(after.outgoingUncleared) - Number(before.outgoingUncleared)).toBe(90_000);

    // Clearing the transfer moves it from the liability into real cash.
    await clearInstrument(app, users.owner, { instrumentId: out.value.id, accountId, date: '2026-06-03' });
    const cleared = await getCashPosition(app, users.owner, accountId);
    expect(cleared.real).toBe(950_000);
  });

  it('a reversing movement nets a mistaken clearing out', async () => {
    const accountId = await bank(0);
    const r = await receiveInstrument(app, users.office, cheque(60_000, { clientId }), { today: TODAY });
    if (!r.ok) throw new Error('setup');
    await deposit(r.value.id, accountId);
    await clearInstrument(app, users.owner, { instrumentId: r.value.id, accountId, date: '2026-06-02' });
    expect((await getCashPosition(app, users.owner, accountId)).real).toBe(60_000);
    const movement = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>(`select id from money_movement where source_id = $1`, [r.value.id]),
    );
    await reverseMovement(
      app,
      users.owner,
      { movementId: movement.rows[0]?.id, reason: 'erreur de saisie' },
      { today: TODAY },
    );
    expect((await getCashPosition(app, users.owner, accountId)).real).toBe(0);
  });

  it('a bounced or cancelled cheque is in neither view', async () => {
    const accountId = await bank(0);
    const r = await receiveInstrument(app, users.office, cheque(70_000, { clientId }), { today: TODAY });
    if (!r.ok) throw new Error('setup');
    await deposit(r.value.id, accountId);
    expect((await getCashPosition(app, users.owner, accountId)).total).toBe(70_000);
    await inCtx(users.owner, (tx) =>
      tx.query(
        `insert into instrument_event (id, instrument_id, event, at_date, created_by) values (gen_random_uuid(), $1, 'bounced', $2, $3)`,
        [r.value.id, TODAY, users.owner.id],
      ),
    );
    expect((await getCashPosition(app, users.owner, accountId)).total).toBe(0);
  });

  it('support reads the same figures; office, partner and plant are refused by the service and by the database', async () => {
    const accountId = await bank(5_000);
    expect((await getCashPosition(app, users.support, accountId)).real).toBe(5_000);
    for (const role of ['office', 'partner', 'plant'] as const) {
      await expect(getCashPosition(app, users[role])).rejects.toThrow();
      for (const table of ['money_account', 'opening_balance', 'money_movement', 'payment_instrument']) {
        expect(
          (await inCtx(users[role], (tx) => tx.query(`select 1 from ${table}`))).rows,
          `${role} ${table}`,
        ).toEqual([]);
      }
    }
    // What office gets back from its own entries holds no balance or total.
    const entered = await receiveInstrument(app, users.office, cheque(1_234, { clientId }), { today: TODAY });
    expectNoFields(entered.ok ? entered.value : {}, [
      'real',
      'total',
      'balance',
      'amountCentimes',
      'incomingUncleared',
    ]);
  });
});
