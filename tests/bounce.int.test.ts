import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocate,
  bounceInstrument,
  clearInstrument,
  depositInstruments,
  disputeInstrument,
  getCashPosition,
  listInstruments,
  orderCoverage,
  receiveInstrument,
  regularizeInstrument,
  regularizationDeadline,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { insertInstrument, insertOrderWithItems, moneyMaster, orderMaster } from './helpers/ledger-fixtures';

// ledger L13: bounce, the 30-day window (law 71.24), regularize, dispute. AC-LED-05, AC-LED-06.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `bnc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';
let master: Awaited<ReturnType<typeof orderMaster>>;
let bankId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await orderMaster(app, users.owner.id, marker);
  bankId = (await moneyMaster(app, users.owner.id, marker)).bankId;
});

/** A client with an order of 9 360,00 (items 3 000,00 due 2026-07-01 and 6 360,00 due 2026-07-02) and a deposited cheque covering the first item. */
async function scene() {
  const { clientId, order, cheque } = await inCtx(users.owner, async (tx) => {
    const client = await tx.query<{ id: string }>(
      `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
      [`bnc ${randomUUID()}`],
    );
    const id = client.rows[0]?.id as string;
    const order = await insertOrderWithItems(tx, users.owner.id, master, id, [300_000, 636_000]);
    const cheque = await insertInstrument(tx, users.owner.id, { clientId: id, amountCentimes: 300_000 });
    return { clientId: id, order, cheque };
  });
  expect(
    (
      await allocate(app, users.owner, {
        instrumentId: cheque.id,
        itemId: order.itemIds[0],
        amountCentimes: 300_000,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await depositInstruments(app, users.owner, {
        instrumentIds: [cheque.id],
        accountId: bankId,
        date: '2026-06-02',
      })
    ).ok,
  ).toBe(true);
  return { clientId, order, chequeId: cheque.id };
}
const find = async (id: string) => (await listInstruments(app, users.owner)).find((i) => i.id === id);
const receiveCash = async (clientId: string, amount = 300_000) => {
  const r = await receiveInstrument(
    app,
    users.office,
    { method: 'cash', amountCentimes: amount, clientId },
    { today: TODAY },
  );
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};

describe('the window of law 71.24 is the same in the database and in the domain', () => {
  it.each(['2026-06-02', '2026-06-03', '2026-12-15', '2028-01-30'])(
    'bounce on %s: deadline +30 days',
    async (date) => {
      const s = await scene();
      const bounced = await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date });
      expect(bounced).toEqual({
        ok: true,
        value: { id: s.chequeId, regularizationDeadline: regularizationDeadline(date) },
      });
      const row = (
        await inCtx(users.owner, (tx) =>
          tx.query<{ d: string }>(
            `select to_char(regularization_deadline, 'YYYY-MM-DD') as d from instrument_event where instrument_id = $1 and event = 'bounced'`,
            [s.chequeId],
          ),
        )
      ).rows[0];
      expect(row?.d).toBe(regularizationDeadline(date));
    },
  );
});

describe('bounce (AC-LED-05)', () => {
  it('a cheque bounced on D3 gets D3+30, uncovers its items, and the item is overdue once past due', async () => {
    const s = await scene();
    expect(
      (await orderCoverage(app, users.owner, s.order.id, { today: '2026-06-10' })).map((i) => i.state),
    ).toEqual(['covered', 'pending']);
    const bounced = await bounceInstrument(app, users.owner, {
      instrumentId: s.chequeId,
      date: '2026-06-05',
    });
    expect(bounced.ok && bounced.value.regularizationDeadline).toBe('2026-07-05');
    expect((await find(s.chequeId))?.state).toBe('bounced');
    expect(
      (await orderCoverage(app, users.owner, s.order.id, { today: '2026-06-10' })).map(
        (i) => i.coveredCentimes,
      ),
    ).toEqual([0, 0]);
    expect(
      (await orderCoverage(app, users.owner, s.order.id, { today: '2026-07-10' })).map((i) => i.state),
    ).toEqual(['overdue', 'overdue']);
    // The allocation history keeps both rows.
    const rows = await inCtx(users.owner, (tx) =>
      tx.query('select 1 from allocation where instrument_id = $1', [s.chequeId]),
    );
    expect(rows.rows).toHaveLength(2);
    // And nothing can cover from a bounced instrument any more.
    expect(
      await allocate(app, users.owner, {
        instrumentId: s.chequeId,
        itemId: s.order.itemIds[0],
        amountCentimes: 100,
      }),
    ).toEqual({ ok: false, error: 'NOT_ALLOWED' });
  });

  it('records the bank fee as an expense out of the account it was deposited to, once per bounce', async () => {
    const s = await scene();
    const before = (await getCashPosition(app, users.owner, bankId)).real;
    await bounceInstrument(app, users.owner, {
      instrumentId: s.chequeId,
      date: '2026-06-05',
      feeCentimes: 2_500,
    });
    expect(Number((await getCashPosition(app, users.owner, bankId)).real) - Number(before)).toBe(-2_500);
    const fee = await inCtx(users.owner, (tx) =>
      tx.query(
        `select 1 from money_movement where source = 'expense' and reason = 'frais de rejet' and account_id = $1`,
        [bankId],
      ),
    );
    expect(fee.rows.length).toBeGreaterThan(0);
  });

  it('only a deposited cheque or LCN can bounce: not a received one, not a cleared one, not cash', async () => {
    const s = await scene();
    const received = await receiveInstrument(
      app,
      users.office,
      {
        method: 'cheque',
        amountCentimes: 10,
        clientId: s.clientId,
        number: `R${randomUUID().slice(0, 8)}`,
        bank: 'B',
        writtenDate: TODAY,
      },
      { today: TODAY },
    );
    if (!received.ok) throw new Error('setup');
    expect(
      await bounceInstrument(app, users.owner, { instrumentId: received.value.id, date: TODAY }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
    await clearInstrument(app, users.owner, {
      instrumentId: s.chequeId,
      accountId: bankId,
      date: '2026-06-03',
    });
    expect(
      await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date: '2026-06-04' }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
    expect(
      await bounceInstrument(app, users.owner, { instrumentId: await receiveCash(s.clientId), date: TODAY }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
  });

  it('a failed bounce writes nothing (no half-undone allocations)', async () => {
    const s = await scene();
    const failed = await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date: '2026-06-01' });
    expect(failed).toEqual({ ok: false, error: 'INVALID' }); // dated before the deposit
    expect((await find(s.chequeId))?.state).toBe('deposited');
    const rows = await inCtx(users.owner, (tx) =>
      tx.query('select 1 from allocation where instrument_id = $1', [s.chequeId]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it.each(['office', 'partner', 'plant', 'support'] as const)(
    '%s cannot bounce, regularize or dispute',
    async (role) => {
      const s = await scene();
      await expect(
        bounceInstrument(app, users[role], { instrumentId: s.chequeId, date: TODAY }),
      ).rejects.toThrow();
      await expect(
        regularizeInstrument(app, users[role], {
          instrumentId: s.chequeId,
          coveringInstrumentId: randomUUID(),
          date: TODAY,
        }),
      ).rejects.toThrow();
      await expect(
        disputeInstrument(app, users[role], { instrumentId: s.chequeId, reason: 'test', date: TODAY }),
      ).rejects.toThrow();
    },
  );
});

describe('regularize and dispute (AC-LED-06)', () => {
  it('a covering instrument inside the window regularizes it; the window closes and both stay in the history', async () => {
    const s = await scene();
    await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date: '2026-06-05' });
    const cover = await receiveCash(s.clientId);
    expect(
      (
        await regularizeInstrument(app, users.owner, {
          instrumentId: s.chequeId,
          coveringInstrumentId: cover,
          date: '2026-07-05',
        })
      ).ok,
    ).toBe(true);
    const bounced = await find(s.chequeId);
    expect(bounced?.state).toBe('regularized');
    expect(bounced?.events.map((e) => e.event)).toEqual(['received', 'deposited', 'bounced', 'regularized']);
    expect(bounced?.events[3]?.coveringInstrumentId).toBe(cover);
    expect(await find(cover)).toMatchObject({ method: 'cash', state: 'cleared' });
    // Closed: neither a second regularization nor a dispute is possible.
    expect(
      await regularizeInstrument(app, users.owner, {
        instrumentId: s.chequeId,
        coveringInstrumentId: await receiveCash(s.clientId),
        date: '2026-07-05',
      }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
    expect(
      await disputeInstrument(app, users.owner, {
        instrumentId: s.chequeId,
        reason: 'trop tard',
        date: '2026-07-05',
      }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
  });

  it('refuses after the window, the day after the deadline included', async () => {
    const s = await scene();
    await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date: '2026-06-05' });
    const cover = await receiveCash(s.clientId);
    expect(
      await regularizeInstrument(app, users.owner, {
        instrumentId: s.chequeId,
        coveringInstrumentId: cover,
        date: '2026-07-06',
      }),
    ).toEqual({ ok: false, error: 'WINDOW_CLOSED' });
    expect(
      (
        await regularizeInstrument(app, users.owner, {
          instrumentId: s.chequeId,
          coveringInstrumentId: cover,
          date: '2026-07-05',
        })
      ).ok,
    ).toBe(true);
  });

  it("needs a covering instrument that is the same client's, incoming, big enough, live and used once", async () => {
    const s = await scene();
    await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date: '2026-06-05' });
    const other = await scene();
    const reg = (cover: string, instrumentId = s.chequeId) =>
      regularizeInstrument(app, users.owner, {
        instrumentId,
        coveringInstrumentId: cover,
        date: '2026-06-20',
      });
    expect(await reg(await receiveCash(other.clientId))).toEqual({ ok: false, error: 'COVERING_INVALID' });
    expect(await reg(await receiveCash(s.clientId, 299_999))).toEqual({
      ok: false,
      error: 'COVERING_INVALID',
    });
    expect(await reg(s.chequeId)).toEqual({ ok: false, error: 'COVERING_INVALID' });
    expect(await reg(randomUUID())).toEqual({ ok: false, error: 'COVERING_INVALID' });
    expect(
      await regularizeInstrument(app, users.owner, {
        instrumentId: s.chequeId,
        coveringInstrumentId: 'not-an-id',
        date: TODAY,
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    const good = await receiveCash(s.clientId, 400_000);
    expect((await reg(good)).ok).toBe(true);
    // The same covering instrument cannot regularize a second bounced cheque.
    const t = await scene();
    await bounceInstrument(app, users.owner, { instrumentId: t.chequeId, date: '2026-06-05' });
    expect(
      await regularizeInstrument(app, users.owner, {
        instrumentId: t.chequeId,
        coveringInstrumentId: good,
        date: '2026-06-20',
      }),
    ).toEqual({ ok: false, error: 'COVERING_INVALID' });
  });

  it('a dispute closes the window and flags the client; it needs a reason and can come after the deadline', async () => {
    const s = await scene();
    await bounceInstrument(app, users.owner, { instrumentId: s.chequeId, date: '2026-06-05' });
    expect((await find(s.chequeId))?.clientDisputed).toBe(false);
    expect(
      await disputeInstrument(app, users.owner, {
        instrumentId: s.chequeId,
        reason: ' ',
        date: '2026-06-06',
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      (
        await disputeInstrument(app, users.owner, {
          instrumentId: s.chequeId,
          reason: 'le client conteste le chèque',
          date: '2026-09-01',
        })
      ).ok,
    ).toBe(true);
    expect(await find(s.chequeId)).toMatchObject({ state: 'disputed', clientDisputed: true });
    expect(
      await regularizeInstrument(app, users.owner, {
        instrumentId: s.chequeId,
        coveringInstrumentId: await receiveCash(s.clientId),
        date: '2026-09-01',
      }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
  });

  it('the database fills the deadline itself and refuses one given by the caller or a regularization without a covering instrument', async () => {
    const s = await scene();
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into instrument_event (id, instrument_id, event, at_date, regularization_deadline, created_by) values (gen_random_uuid(), $1, 'bounced', '2026-06-05', '2030-01-01', $2)`,
          [s.chequeId, users.owner.id],
        ),
      ),
    ).resolves.toBeTruthy();
    const d = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ d: string }>(
          `select to_char(regularization_deadline, 'YYYY-MM-DD') as d from instrument_event where instrument_id = $1 and event = 'bounced'`,
          [s.chequeId],
        ),
      )
    ).rows[0]?.d;
    expect(d).toBe('2026-07-05');
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into instrument_event (id, instrument_id, event, at_date, created_by) values (gen_random_uuid(), $1, 'regularized', '2026-06-06', $2)`,
          [s.chequeId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
