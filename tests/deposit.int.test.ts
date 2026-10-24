import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  clearInstrument,
  depositInstruments,
  issueInstrument,
  listInstruments,
  receiveInstrument,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { moneyMaster, orderMaster } from './helpers/ledger-fixtures';

// ledger L12: deposit batch and early presentation. AC-LED-14, AC-LED-04 (one batch = one event per instrument).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `dep${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';
let clientId: string;
let supplierId: string;
let bankId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  clientId = (await orderMaster(app, users.owner.id, marker)).clientId;
  const m = await moneyMaster(app, users.owner.id, marker);
  supplierId = m.supplierId;
  bankId = m.bankId;
});

const receive = async (writtenDate = TODAY, method: 'cheque' | 'lcn' = 'cheque') => {
  const r = await receiveInstrument(
    app,
    users.office,
    {
      method,
      amountCentimes: 100_000,
      clientId,
      number: `D${randomUUID().replace(/-/g, '').slice(0, 9)}`,
      bank: 'B',
      writtenDate,
    },
    { today: TODAY },
  );
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};
const find = async (id: string) => (await listInstruments(app, users.owner)).find((i) => i.id === id);
const eventsOf = async (id: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query<{ event: string }>(
        'select event from instrument_event where instrument_id = $1 order by seq',
        [id],
      ),
    )
  ).rows.map((r) => r.event);

describe('deposit batch', () => {
  it('deposits a selection in one go: one event per instrument, into the bank, dated', async () => {
    const ids = [await receive(), await receive(TODAY, 'lcn'), await receive()];
    expect(
      await depositInstruments(app, users.owner, {
        instrumentIds: ids,
        accountId: bankId,
        date: '2026-06-02',
      }),
    ).toEqual({
      ok: true,
      value: { deposited: 3 },
    });
    for (const id of ids) {
      expect(await eventsOf(id)).toEqual(['received', 'deposited']);
      expect(await find(id)).toMatchObject({ state: 'deposited', stateDate: '2026-06-02' });
    }
  });

  it('is all or nothing: one instrument that cannot be deposited keeps the whole batch out', async () => {
    const good = await receive();
    const done = await receive();
    await depositInstruments(app, users.owner, { instrumentIds: [done], accountId: bankId, date: TODAY });
    expect(
      await depositInstruments(app, users.owner, {
        instrumentIds: [good, done],
        accountId: bankId,
        date: TODAY,
      }),
    ).toEqual({
      ok: false,
      error: 'ILLEGAL_TRANSITION',
    });
    expect(await eventsOf(good)).toEqual(['received']);
    expect(await eventsOf(done)).toEqual(['received', 'deposited']);
  });

  it('refuses cash and transfers, a caisse as the destination, an empty or duplicated selection', async () => {
    const cash = await receiveInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 100, clientId },
      { today: TODAY },
    );
    if (!cash.ok) throw new Error('setup');
    expect(
      (
        await depositInstruments(app, users.owner, {
          instrumentIds: [cash.value.id],
          accountId: bankId,
          date: TODAY,
        })
      ).ok,
    ).toBe(false);
    const c = await receive();
    const caisse = (
      await inCtx(users.owner, (tx) => tx.query<{ id: string }>('select public.default_cash_account() as id'))
    ).rows[0]?.id;
    expect(
      await depositInstruments(app, users.owner, { instrumentIds: [c], accountId: caisse, date: TODAY }),
    ).toEqual({ ok: false, error: 'ACCOUNT_MISMATCH' });
    expect(
      await depositInstruments(app, users.owner, { instrumentIds: [], accountId: bankId, date: TODAY }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await depositInstruments(app, users.owner, { instrumentIds: [c, c], accountId: bankId, date: TODAY }),
    ).toEqual({ ok: false, error: 'INVALID' });
  });

  it.each(['office', 'partner', 'plant', 'support'] as const)('%s cannot deposit', async (role) => {
    const id = await receive();
    await expect(
      depositInstruments(app, users[role], { instrumentIds: [id], accountId: bankId, date: TODAY }),
    ).rejects.toThrow();
  });
});

describe('early presentation (AC-LED-14)', () => {
  it('a post-dated cheque deposited before its written date is accepted and flagged early; on or after it, not', async () => {
    const future = await receive('2026-07-15');
    const onTheDay = await receive('2026-06-10');
    expect(
      (
        await depositInstruments(app, users.owner, {
          instrumentIds: [future],
          accountId: bankId,
          date: '2026-06-05',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await depositInstruments(app, users.owner, {
          instrumentIds: [onTheDay],
          accountId: bankId,
          date: '2026-06-10',
        })
      ).ok,
    ).toBe(true);
    expect((await find(future))?.events.map((e) => [e.event, e.early])).toEqual([
      ['received', false],
      ['deposited', true],
    ]);
    expect((await find(onTheDay))?.events.map((e) => [e.event, e.early])).toEqual([
      ['received', false],
      ['deposited', false],
    ]);
    expect((await find(future))?.postDated).toBe(true);
  });

  it('an early cleared event is flagged too, and the money moves at the date it was cleared', async () => {
    const id = await receive('2026-08-01');
    await depositInstruments(app, users.owner, {
      instrumentIds: [id],
      accountId: bankId,
      date: '2026-06-02',
    });
    expect(
      (await clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: '2026-06-03' }))
        .ok,
    ).toBe(true);
    expect((await find(id))?.events.map((e) => e.early)).toEqual([false, true, true]);
    const m = await inCtx(users.owner, (tx) =>
      tx.query<{ d: string }>(
        `select to_char(movement_date, 'YYYY-MM-DD') as d from money_movement where source_id = $1`,
        [id],
      ),
    );
    expect(m.rows[0]?.d).toBe('2026-06-03');
  });

  it('an outgoing post-dated cheque can be cleared before its written date, flagged early', async () => {
    const r = await issueInstrument(
      app,
      users.office,
      {
        method: 'cheque',
        amountCentimes: 80_000,
        supplierId,
        number: `E${randomUUID().replace(/-/g, '').slice(0, 9)}`,
        bank: 'B',
        writtenDate: '2026-09-01',
      },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(
      (
        await clearInstrument(app, users.owner, {
          instrumentId: r.value.id,
          accountId: bankId,
          date: '2026-06-04',
        })
      ).ok,
    ).toBe(true);
    expect((await find(r.value.id))?.events.map((e) => [e.event, e.early])).toEqual([
      ['issued', false],
      ['cleared', true],
    ]);
  });
});
