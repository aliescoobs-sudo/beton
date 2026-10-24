import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocate,
  cancelInstrument,
  cancelOrder,
  issueInstrument,
  orderCoverage,
  receiveInstrument,
  unallocate,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  insertInstrument,
  insertOrderWithItems,
  moneyMaster,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// ledger L11: allocations. An instrument covers plan items; sums never exceed either side, even in parallel.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 12 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `alc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';
let master: OrderMaster;
let supplierId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await orderMaster(app, users.owner.id, marker);
  supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
});

/** A fresh client with an order split in `items` and a cheque of `cheque` centimes, all by the owner. */
async function scene(items: number[] = [936_000], cheque = 936_000) {
  return inCtx(users.owner, async (tx) => {
    const client = await tx.query<{ id: string }>(
      `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
      [`alc ${randomUUID()}`],
    );
    const clientId = client.rows[0]?.id as string;
    const order = await insertOrderWithItems(tx, users.owner.id, master, clientId, items);
    const instrument = await insertInstrument(tx, users.owner.id, { clientId, amountCentimes: cheque });
    return { clientId, ...order, instrumentId: instrument.id };
  });
}
const coverage = async (orderId: string) => orderCoverage(app, users.owner, orderId, { today: TODAY });
const covered = async (orderId: string) => (await coverage(orderId)).map((i) => i.coveredCentimes);

describe('allocate and unallocate', () => {
  it('one cheque covers two items; the states follow (AC-LED-04 neighbours, plan-item state)', async () => {
    const s = await scene([300_000, 636_000]);
    expect((await coverage(s.id)).map((i) => i.state)).toEqual(['pending', 'pending']);
    expect(
      (
        await allocate(app, users.owner, {
          instrumentId: s.instrumentId,
          itemId: s.itemIds[0],
          amountCentimes: 300_000,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await allocate(app, users.owner, {
          instrumentId: s.instrumentId,
          itemId: s.itemIds[1],
          amountCentimes: 100_000,
        })
      ).ok,
    ).toBe(true);
    expect((await coverage(s.id)).map((i) => i.state)).toEqual(['covered', 'partially_covered']);
    expect(await covered(s.id)).toEqual([300_000, 100_000]);
  });

  it('several instruments cover one item, and an undone allocation uncovers it with a negated row', async () => {
    const s = await scene([500_000, 436_000], 200_000);
    const second = await inCtx(users.owner, (tx) =>
      insertInstrument(tx, users.owner.id, { clientId: s.clientId, amountCentimes: 300_000 }),
    );
    const a = await allocate(app, users.owner, {
      instrumentId: s.instrumentId,
      itemId: s.itemIds[0],
      amountCentimes: 200_000,
    });
    const b = await allocate(app, users.owner, {
      instrumentId: second.id,
      itemId: s.itemIds[0],
      amountCentimes: 300_000,
    });
    if (!a.ok || !b.ok) throw new Error('setup');
    expect((await coverage(s.id))[0]?.state).toBe('covered');
    expect(
      (await unallocate(app, users.owner, { allocationId: a.value.id, reason: 'mauvais chèque' })).ok,
    ).toBe(true);
    expect((await coverage(s.id))[0]).toMatchObject({ coveredCentimes: 300_000, state: 'partially_covered' });
    expect(await unallocate(app, users.owner, { allocationId: a.value.id, reason: 'encore' })).toEqual({
      ok: false,
      error: 'CONFLICT',
    });
    expect(await unallocate(app, users.owner, { allocationId: randomUUID(), reason: 'x' })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await unallocate(app, users.owner, { allocationId: b.value.id, reason: ' ' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('a past due date makes an uncovered or partly covered item overdue', async () => {
    const s = await scene([500_000, 436_000]);
    const later = await orderCoverage(app, users.owner, s.id, { today: '2026-07-15' });
    expect(later.map((i) => i.state)).toEqual(['overdue', 'overdue']);
  });

  it('refuses more than the instrument and more than the item, in the service and in the database', async () => {
    const s = await scene([500_000, 436_000], 600_000);
    expect(
      await allocate(app, users.owner, {
        instrumentId: s.instrumentId,
        itemId: s.itemIds[0],
        amountCentimes: 500_001,
      }),
    ).toEqual({ ok: false, error: 'EXCEEDS_ITEM' });
    expect(
      (
        await allocate(app, users.owner, {
          instrumentId: s.instrumentId,
          itemId: s.itemIds[0],
          amountCentimes: 500_000,
        })
      ).ok,
    ).toBe(true);
    expect(
      await allocate(app, users.owner, {
        instrumentId: s.instrumentId,
        itemId: s.itemIds[1],
        amountCentimes: 100_001,
      }),
    ).toEqual({ ok: false, error: 'EXCEEDS_INSTRUMENT' });
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, 100001, $3)`,
          [s.instrumentId, s.itemIds[1], users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await allocate(app, users.owner, {
        instrumentId: s.instrumentId,
        itemId: s.itemIds[1],
        amountCentimes: 0,
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
  });

  it('refuses another client, the wrong direction, a cancelled instrument and the item of a cancelled order', async () => {
    const s = await scene([936_000], 936_000);
    const other = await scene([936_000], 936_000);
    expect(
      await allocate(app, users.owner, {
        instrumentId: other.instrumentId,
        itemId: s.itemIds[0],
        amountCentimes: 100,
      }),
    ).toEqual({ ok: false, error: 'NOT_ALLOWED' });
    const out = await issueInstrument(
      app,
      users.owner,
      { method: 'transfer', amountCentimes: 936_000, supplierId },
      { today: TODAY },
    );
    if (!out.ok) throw new Error('setup');
    expect(
      await allocate(app, users.owner, {
        instrumentId: out.value.id,
        itemId: s.itemIds[0],
        amountCentimes: 100,
      }),
    ).toEqual({ ok: false, error: 'NOT_ALLOWED' });
    expect(
      (
        await cancelInstrument(app, users.owner, {
          instrumentId: s.instrumentId,
          reason: 'annulé',
          date: TODAY,
        })
      ).ok,
    ).toBe(true);
    expect(
      await allocate(app, users.owner, {
        instrumentId: s.instrumentId,
        itemId: s.itemIds[0],
        amountCentimes: 100,
      }),
    ).toEqual({ ok: false, error: 'NOT_ALLOWED' });
    const cancelled = await cancelOrder(app, users.owner, other.id, 'commande annulée', {}, { today: TODAY });
    expect(cancelled.ok).toBe(true);
    const fresh = await inCtx(users.owner, (tx) =>
      insertInstrument(tx, users.owner.id, { clientId: other.clientId, amountCentimes: 100 }),
    );
    expect(
      await allocate(app, users.owner, {
        instrumentId: fresh.id,
        itemId: other.itemIds[0],
        amountCentimes: 100,
      }),
    ).toEqual({ ok: false, error: 'NOT_ALLOWED' });
    expect((await coverage(other.id)).map((i) => i.state)).toEqual(['cancelled']);
  });

  it('the database refuses a reversal of a reversal and one that does not negate exactly', async () => {
    const s = await scene();
    const a = await allocate(app, users.owner, {
      instrumentId: s.instrumentId,
      itemId: s.itemIds[0],
      amountCentimes: 1_000,
    });
    if (!a.ok) throw new Error('setup');
    const rev = (amount: number, of: string) =>
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, reverses_id, reason, created_by)
           values (gen_random_uuid(), $1, $2, $3, $4, 'test', $5)`,
          [s.instrumentId, s.itemIds[0], amount, of, users.owner.id],
        ),
      );
    await expect(rev(-999, a.value.id)).rejects.toMatchObject({ code: '23514' });
    await rev(-1_000, a.value.id);
    const reversal = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>('select id from allocation where reverses_id = $1', [a.value.id]),
    );
    await expect(rev(1_000, reversal.rows[0]?.id as string)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('who may allocate', () => {
  it.each(['office', 'partner', 'plant', 'support'] as const)(
    '%s has no direct allocation path',
    async (role) => {
      const s = await scene();
      await expect(
        allocate(app, users[role], {
          instrumentId: s.instrumentId,
          itemId: s.itemIds[0],
          amountCentimes: 100,
        }),
      ).rejects.toThrow();
      await expect(
        unallocate(app, users[role], { allocationId: randomUUID(), reason: 'test' }),
      ).rejects.toThrow();
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, 100, $3)`,
            [s.instrumentId, s.itemIds[0], users[role].id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('office covers an order by its code, oldest item first, and learns only the instrument id', async () => {
    const s = await scene([300_000, 636_000]);
    const r = await receiveInstrument(
      app,
      users.office,
      {
        method: 'cheque',
        amountCentimes: 400_000,
        clientId: s.clientId,
        number: `A${randomUUID().slice(0, 8)}`,
        bank: 'B',
        writtenDate: TODAY,
        orderCode: s.code,
      },
      { today: TODAY },
    );
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['effects', 'id']);
    expect(JSON.stringify(r.ok && r.value)).not.toMatch(/amountCentimes/); // the effects office may see hold no amount
    expect(await covered(s.id)).toEqual([300_000, 100_000]);
  });

  it('a code that fits nothing (unknown, another client, already paid) rolls the entry back', async () => {
    const s = await scene([936_000]);
    const other = await scene([936_000]);
    const enter = (clientId: string, orderCode: string, amount = 100) =>
      receiveInstrument(
        app,
        users.office,
        { method: 'transfer', amountCentimes: amount, clientId, orderCode },
        { today: TODAY },
      );
    const count = async () =>
      (
        await inCtx(users.owner, (tx) =>
          tx.query<{ n: string }>('select count(*)::text as n from payment_instrument where client_id = $1', [
            s.clientId,
          ]),
        )
      ).rows[0]?.n;
    const before = await count();
    expect(await enter(s.clientId, 'CMD-1999-99999')).toEqual({ ok: false, error: 'NOTHING_TO_ALLOCATE' });
    expect(await enter(s.clientId, other.code)).toEqual({ ok: false, error: 'NOTHING_TO_ALLOCATE' });
    expect(await count()).toBe(before);
    await allocate(app, users.owner, {
      instrumentId: s.instrumentId,
      itemId: s.itemIds[0],
      amountCentimes: 936_000,
    });
    expect(await enter(s.clientId, s.code)).toEqual({ ok: false, error: 'NOTHING_TO_ALLOCATE' });
  });

  it("office cannot cover an order with someone else's instrument", async () => {
    const s = await scene();
    const otherOffice = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
    const { rows } = await inCtx(otherOffice, (tx) =>
      tx.query<{ n: number }>('select public.allocate_to_order($1, $2) as n', [s.instrumentId, s.code]),
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('parallel allocations never exceed either side', () => {
  it('10 owner allocations of 30% against one item and one instrument: exactly 3 succeed', async () => {
    // The first item is 1 000 and the rest of the 9 360,00 order sits in the second.
    const t = await scene([1_000, 935_000], 1_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        allocate(app, users.owner, {
          instrumentId: t.instrumentId,
          itemId: t.itemIds[0],
          amountCentimes: 300,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await covered(t.id))[0]).toBe(900);
  });

  it('10 office entries against the same order cover it exactly, never more', async () => {
    const s = await scene([300_000, 636_000]);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        receiveInstrument(
          app,
          users.office,
          {
            method: 'cheque',
            amountCentimes: 400_000,
            clientId: s.clientId,
            number: `P${n}${randomUUID().slice(0, 8)}`,
            bank: 'B',
            writtenDate: TODAY,
            orderCode: s.code,
          },
          { today: TODAY },
        ),
      ),
    );
    expect(await covered(s.id)).toEqual([300_000, 636_000]);
    const per = await inCtx(users.owner, (tx) =>
      tx.query<{ s: string; amount: string }>(
        `select coalesce(sum(a.amount_centimes), 0)::text as s, i.amount_centimes::text as amount
           from payment_instrument i left join allocation a on a.instrument_id = i.id where i.client_id = $1 group by i.id`,
        [s.clientId],
      ),
    );
    for (const row of per.rows) expect(Number(row.s)).toBeLessThanOrEqual(Number(row.amount));
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(3);
  });
});

describe('visibility and immutability', () => {
  it('office, partner and plant read no allocation; owner and support do; nobody edits or deletes', async () => {
    const s = await scene();
    await allocate(app, users.owner, {
      instrumentId: s.instrumentId,
      itemId: s.itemIds[0],
      amountCentimes: 100,
    });
    for (const role of ['office', 'partner', 'plant'] as const)
      expect((await inCtx(users[role], (tx) => tx.query('select 1 from allocation'))).rows).toEqual([]);
    for (const role of ['owner', 'support'] as const)
      expect(
        (await inCtx(users[role], (tx) => tx.query('select 1 from allocation'))).rows.length,
      ).toBeGreaterThan(0);
    for (const sql of [
      'update allocation set amount_centimes = 1',
      'delete from allocation',
      'truncate allocation',
    ])
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  });

  it('allocate_to_order is refused to partner, plant and support', async () => {
    for (const role of ['partner', 'plant', 'support'] as const)
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(`select public.allocate_to_order(gen_random_uuid(), 'CMD-2026-00001')`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
  });
});
