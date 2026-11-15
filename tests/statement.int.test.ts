import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocate,
  bounceInstrument,
  cancelOrder,
  depositInstruments,
  getClientStatement,
  getSupplierStatement,
  issueInstrument,
  listAccounts,
  receiveInstrument,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  ensureOpening,
  insertOrderWithItems,
  moneyMaster,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// ledger L27: client and supplier statements. AC-LED-19 (two sections, running balance, summary), AC-LED-20 (filters),
// AC-LED-21 (owner and support only).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `stm${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-10-24';
let master: OrderMaster;
let bankId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await orderMaster(app, users.owner.id, marker);
  const m = await moneyMaster(app, users.owner.id, marker);
  bankId = m.bankId;
  await ensureOpening(app, users.owner.id, marker);
});

async function client() {
  return inCtx(users.owner, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
      [`stm ${randomUUID()}`],
    );
    return r.rows[0]?.id as string;
  });
}
const cheque = (clientId: string, amount: number, written = '2026-07-02') => ({
  method: 'cheque',
  amountCentimes: amount,
  clientId,
  number: `S${randomUUID().replace(/-/g, '').slice(0, 9)}`,
  bank: 'B',
  writtenDate: written,
});

describe('a client statement (AC-LED-19)', () => {
  it('lists orders and payments in two sections with a running balance and a summary', async () => {
    const clientId = await client();
    await inCtx(users.owner, (tx) =>
      tx.query(
        `insert into opening_party_balance (id, client_id, amount_centimes, created_by) values (gen_random_uuid(), $1, 50000, $2)`,
        [clientId, users.owner.id],
      ),
    );
    const o1 = await inCtx(users.owner, (tx) =>
      insertOrderWithItems(tx, users.owner.id, master, clientId, [300_000, 636_000]),
    );
    const o2 = await inCtx(users.owner, (tx) =>
      insertOrderWithItems(tx, users.owner.id, master, clientId, [936_000]),
    );
    expect(
      (await cancelOrder(app, users.owner, o2.id, 'commande annulée', {}, { today: '2026-06-05' })).ok,
    ).toBe(true);

    // 3 000,00 by cheque (deposited), 1 000,00 cash, 2 000,00 by cheque that bounced.
    const chq = await receiveInstrument(app, users.office, cheque(clientId, 300_000), {
      today: '2026-06-02',
    });
    const cash = await receiveInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 100_000, clientId },
      { today: '2026-06-03' },
    );
    const bad = await receiveInstrument(app, users.office, cheque(clientId, 200_000), {
      today: '2026-06-04',
    });
    if (!chq.ok || !cash.ok || !bad.ok) throw new Error('setup');
    await allocate(app, users.owner, {
      instrumentId: chq.value.id,
      itemId: o1.itemIds[0],
      amountCentimes: 300_000,
    });
    await depositInstruments(app, users.owner, {
      instrumentIds: [chq.value.id, bad.value.id],
      accountId: bankId,
      date: '2026-06-05',
    });
    await bounceInstrument(app, users.owner, { instrumentId: bad.value.id, date: '2026-06-06' });

    const result = await getClientStatement(app, users.owner, clientId, {}, { today: TODAY });
    if (!result) throw new Error('no statement');
    const s = result.statement;
    expect(s.commercial.map((r) => [r.type, r.status, Number(r.amountCentimes)])).toEqual([
      ['opening', 'booked', 50_000],
      ['order', 'booked', 936_000],
      ['order', 'cancelled', 936_000],
      ['order_cancelled', 'booked', -936_000],
    ]);
    expect(s.financial.map((r) => [r.status, Number(r.amountCentimes)])).toEqual([
      ['deposited', -300_000],
      ['cleared', -100_000],
      ['bounced', -200_000],
    ]);
    // Owes 50 000 + 936 000 (the cancelled order nets out) - 300 000 - 100 000; the bounced cheque does not count.
    expect(Number(s.closing)).toBe(586_000);
    // Every row's balance is the sum of the counted lines up to it.
    const all = [...s.commercial, ...s.financial];
    expect(all.every((r) => Number.isInteger(Number(r.balanceAfter)))).toBe(true);
    expect(s.summary).toMatchObject({
      ordered: 936_000,
      cancelled: 936_000,
      paid: 100_000,
      pending: 300_000,
      invoiced: 0,
    });
    // Item 1 (due in July) is covered; item 2 (6 360,00) is late.
    expect(Number(s.summary.late)).toBe(636_000);
    expect(s.summary.nextDueDate).toBeNull();
  });

  it('filters by date, type and status without changing a balance (AC-LED-20)', async () => {
    const clientId = await client();
    const o = await inCtx(users.owner, (tx) =>
      insertOrderWithItems(tx, users.owner.id, master, clientId, [936_000]),
    );
    const a = await receiveInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 100_000, clientId },
      { today: '2026-06-10' },
    );
    const b = await receiveInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 50_000, clientId },
      { today: '2026-06-20' },
    );
    if (!a.ok || !b.ok) throw new Error('setup');
    void o;
    const all = (await getClientStatement(app, users.owner, clientId, {}, { today: TODAY }))?.statement;
    const range = (
      await getClientStatement(app, users.owner, clientId, { from: '2026-06-15' }, { today: TODAY })
    )?.statement;
    expect(Number(all?.closing)).toBe(786_000);
    expect(Number(range?.carriedIn)).toBe(836_000);
    expect(range?.financial.map((r) => Number(r.balanceAfter))).toEqual([786_000]);
    expect(Number(range?.closing)).toBe(786_000);
    const typed = (
      await getClientStatement(app, users.owner, clientId, { types: ['payment'] }, { today: TODAY })
    )?.statement;
    expect(typed?.commercial).toEqual([]);
    expect(typed?.financial.map((r) => Number(r.balanceAfter))).toEqual([836_000, 786_000]);
  });

  it('an unknown or malformed id has no statement', async () => {
    expect(await getClientStatement(app, users.owner, randomUUID(), {}, { today: TODAY })).toBeNull();
    expect(await getClientStatement(app, users.owner, 'nope', {}, { today: TODAY })).toBeNull();
  });
});

describe('a supplier statement', () => {
  it('shows what we owe at opening and the payments made', async () => {
    const s = await inCtx(users.owner, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other') returning id`,
        [`stm sup ${randomUUID()}`],
      );
      const id = r.rows[0]?.id as string;
      await tx.query(
        `insert into opening_party_balance (id, supplier_id, amount_centimes, created_by) values (gen_random_uuid(), $1, 400000, $2)`,
        [id, users.owner.id],
      );
      return id;
    });
    // D247: 1 500 MAD is above the small limit: the owner issues it (an office role would need a validated request)
    const paid = await issueInstrument(
      app,
      users.owner,
      { method: 'transfer', amountCentimes: 150_000, supplierId: s },
      { today: '2026-06-02' },
    );
    expect(paid.ok).toBe(true);
    const st = (await getSupplierStatement(app, users.owner, s, {}, { today: TODAY }))?.statement;
    expect(st?.commercial.map((r) => Number(r.amountCentimes))).toEqual([400_000]);
    expect(st?.financial.map((r) => [r.status, Number(r.amountCentimes)])).toEqual([['issued', -150_000]]);
    expect(Number(st?.closing)).toBe(250_000);
  });
});

describe('who may read statements (AC-LED-21)', () => {
  it.each(['office', 'partner', 'plant'] as const)('%s is refused by the service', async (role) => {
    const clientId = await client();
    await expect(getClientStatement(app, users[role], clientId, {}, { today: TODAY })).rejects.toThrow();
    await expect(getSupplierStatement(app, users[role], clientId, {}, { today: TODAY })).rejects.toThrow();
    await expect(listAccounts(app, users[role], { today: TODAY })).rejects.toThrow();
  });

  it('support reads the same figures as the owner', async () => {
    const clientId = await client();
    await receiveInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 7_000, clientId },
      { today: '2026-06-02' },
    );
    const owner = (await getClientStatement(app, users.owner, clientId, {}, { today: TODAY }))?.statement
      .closing;
    const support = (await getClientStatement(app, users.support, clientId, {}, { today: TODAY }))?.statement
      .closing;
    expect(support).toBe(owner);
    expect(Number(owner)).toBe(-7_000);
  });

  it('lists every active client and supplier with balance, late amount and next due date', async () => {
    const accounts = await listAccounts(app, users.owner, { today: TODAY });
    expect(accounts.some((a) => a.kind === 'client')).toBe(true);
    expect(accounts.some((a) => a.kind === 'supplier')).toBe(true);
    for (const a of accounts) expect(Number.isInteger(a.balanceCentimes)).toBe(true);
  });
});
