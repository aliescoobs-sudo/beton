import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelInstrument,
  clearInstrument,
  INSTRUMENT_DIRECTIONS,
  INSTRUMENT_EVENTS,
  INSTRUMENT_METHODS,
  INSTRUMENT_STATES,
  issueInstrument,
  listInstruments,
  nextState,
  receiveInstrument,
  reverseMovement,
} from '../src/modules/ledger';
import { archiveClient, createClient, fieldCipherFrom } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { moneyMaster, newCashMovement, orderMaster } from './helpers/ledger-fixtures';

// ledger L10: instruments, events, `cleared` → movement. AC-LED-03 (instruments, events, movements), AC-LED-04.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `ins${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';

let clientId: string;
let supplierId: string;
let bankId: string;
let caisseId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  clientId = (await orderMaster(app, users.owner.id, marker)).clientId;
  const m = await moneyMaster(app, users.owner.id, marker);
  supplierId = m.supplierId;
  bankId = m.bankId;
  caisseId = (
    await inCtx(users.owner, (tx) => tx.query<{ id: string }>('select public.default_cash_account() as id'))
  ).rows[0]?.id as string;
});

const cheque = (extra: Record<string, unknown> = {}) => ({
  method: 'cheque',
  amountCentimes: 500_000,
  clientId,
  number: `C${randomUUID().replace(/-/g, '').slice(0, 9)}`,
  bank: 'Banque test',
  writtenDate: TODAY,
  ...extra,
});

/** A direct event as the owner (the deposit service is L12). */
const event = (
  actor: SessionUser,
  instrumentId: string,
  name: string,
  date: string,
  accountId: string | null = null,
  reason: string | null = null,
) =>
  inCtx(actor, (tx) =>
    tx.query(
      `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, reason, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [instrumentId, name, date, accountId, reason, actor.id],
    ),
  );
const movements = (instrumentId: string) =>
  inCtx(
    users.owner,
    async (tx) =>
      (
        await tx.query<{ amount_centimes: string; account_id: string }>(
          `select amount_centimes::text, account_id from money_movement where source = 'instrument' and source_id = $1`,
          [instrumentId],
        )
      ).rows,
  );
const receive = async (extra: Record<string, unknown> = {}, actor = users.office) => {
  const r = await receiveInstrument(app, actor, cheque(extra), { today: TODAY });
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};

describe('the lifecycle table in SQL is the one in TypeScript (AC-LED-04)', () => {
  it('agrees on every direction × method × state × event, first events included', async () => {
    const stateOf = (event: string) => event; // events are named after the state they lead to
    for (const d of INSTRUMENT_DIRECTIONS)
      for (const m of INSTRUMENT_METHODS) {
        for (const first of ['received', 'issued']) {
          const { rows } = await migrator.query<{ ok: boolean }>(
            `select public.instrument_transition_allowed($1, $2, null, $3) as ok`,
            [d, m, first],
          );
          expect(rows[0]?.ok, `${d}/${m}/first ${first}`).toBe(
            (d === 'in' ? 'received' : 'issued') === first,
          );
        }
        for (const from of INSTRUMENT_STATES)
          for (const e of INSTRUMENT_EVENTS) {
            const to = {
              deposit: 'deposited',
              clear: 'cleared',
              bounce: 'bounced',
              regularize: 'regularized',
              dispute: 'disputed',
              cancel: 'cancelled',
            }[e];
            const { rows } = await migrator.query<{ ok: boolean }>(
              `select public.instrument_transition_allowed($1, $2, $3, $4) as ok`,
              [d, m, from, stateOf(to)],
            );
            expect(rows[0]?.ok, `${d}/${m}/${from}/${e}`).toBe(nextState(d, m, from, e).ok);
          }
      }
  });
});

describe('receiving and issuing (office enters blind)', () => {
  it('office receives a cheque: it gets an id and nothing else, and cannot read it back', async () => {
    const r = await receiveInstrument(app, users.office, cheque(), { today: TODAY });
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['effects', 'id']);
    expect(JSON.stringify(r.ok && r.value)).not.toMatch(/amountCentimes/); // the effects office may see hold no amount
    const read = await inCtx(users.office, (tx) => tx.query('select * from payment_instrument'));
    expect(read.rows).toEqual([]);
    const events = await inCtx(users.office, (tx) => tx.query('select * from instrument_event'));
    expect(events.rows).toEqual([]);
  });

  it('cash received is cleared into the caisse the same day: exactly one positive movement', async () => {
    const r = await receiveInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 250_000, clientId },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(await movements(r.value.id)).toEqual([{ amount_centimes: '250000', account_id: caisseId }]);
  });

  it('cash paid to a supplier leaves the caisse: one negative movement', async () => {
    const r = await issueInstrument(
      app,
      users.office,
      { method: 'cash', amountCentimes: 80_000, supplierId },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(await movements(r.value.id)).toEqual([{ amount_centimes: '-80000', account_id: caisseId }]);
  });

  it('a cheque or LCN needs a number and a written date; a bank transfer needs neither', async () => {
    expect(await receiveInstrument(app, users.office, cheque({ number: null }), { today: TODAY })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await receiveInstrument(app, users.office, cheque({ writtenDate: null }), { today: TODAY }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      (
        await receiveInstrument(
          app,
          users.office,
          { method: 'transfer', amountCentimes: 100, clientId },
          { today: TODAY },
        )
      ).ok,
    ).toBe(true);
    expect(
      await receiveInstrument(app, users.office, cheque({ amountCentimes: 0 }), { today: TODAY }),
    ).toEqual({ ok: false, error: 'INVALID' });
  });

  it('refuses the same cheque twice and an archived client', async () => {
    const same = cheque();
    expect((await receiveInstrument(app, users.office, same, { today: TODAY })).ok).toBe(true);
    expect(await receiveInstrument(app, users.office, same, { today: TODAY })).toEqual({
      ok: false,
      error: 'DUPLICATE',
    });
    const fresh = await createClient(
      app,
      users.office,
      { name: `Client chq ${marker}`, kind: 'company' },
      deps,
    );
    if (!fresh.ok) throw new Error(fresh.error);
    expect(await archiveClient(app, users.owner, fresh.value.client.id)).toEqual({ ok: true, value: true });
    expect(
      await receiveInstrument(app, users.office, cheque({ clientId: fresh.value.client.id }), {
        today: TODAY,
      }),
    ).toEqual({
      ok: false,
      error: 'PARTY_ARCHIVED',
    });
  });

  it.each(['partner', 'plant', 'support'] as const)('%s cannot receive or issue', async (role) => {
    await expect(receiveInstrument(app, users[role], cheque(), { today: TODAY })).rejects.toThrow();
    await expect(
      issueInstrument(
        app,
        users[role],
        { method: 'transfer', amountCentimes: 1, supplierId },
        { today: TODAY },
      ),
    ).rejects.toThrow();
  });

  it('an instrument without its first event is refused at commit', async () => {
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into payment_instrument (id, direction, method, amount_centimes, client_id, received_date, created_by)
           values (gen_random_uuid(), 'in', 'transfer', 100, $1, $2, $3)`,
          [clientId, TODAY, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the lifecycle through the service and the database (AC-LED-04)', () => {
  it('deposited → cleared writes exactly one movement into the bank, and no second clearing is possible', async () => {
    const id = await receive();
    await event(users.owner, id, 'deposited', TODAY, bankId);
    expect(
      (await clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: '2026-06-02' }))
        .ok,
    ).toBe(true);
    expect(await movements(id)).toEqual([{ amount_centimes: '500000', account_id: bankId }]);
    expect(
      await clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: '2026-06-03' }),
    ).toEqual({
      ok: false,
      error: 'ILLEGAL_TRANSITION',
    });
    expect(await movements(id)).toHaveLength(1);
  });

  it('an outgoing cheque cleared is a negative movement', async () => {
    const r = await issueInstrument(
      app,
      users.office,
      {
        method: 'cheque',
        amountCentimes: 300_000,
        supplierId,
        number: `S${randomUUID().slice(0, 8)}`,
        bank: 'B',
        writtenDate: TODAY,
      },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(
      (await clearInstrument(app, users.owner, { instrumentId: r.value.id, accountId: bankId, date: TODAY }))
        .ok,
    ).toBe(true);
    expect(await movements(r.value.id)).toEqual([{ amount_centimes: '-300000', account_id: bankId }]);
  });

  it('refuses a cheque cleared without a deposit, a cleared instrument bouncing, a transfer deposited', async () => {
    const id = await receive();
    expect(
      await clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: TODAY }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
    await event(users.owner, id, 'deposited', TODAY, bankId);
    await clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: TODAY });
    await expect(event(users.owner, id, 'bounced', TODAY)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/illegal transition/),
    });
    const transfer = await receiveInstrument(
      app,
      users.office,
      { method: 'transfer', amountCentimes: 100, clientId },
      { today: TODAY },
    );
    if (!transfer.ok) throw new Error('setup');
    await expect(event(users.owner, transfer.value.id, 'deposited', TODAY, bankId)).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('checks the account against the method and the dates against the previous event', async () => {
    const id = await receive();
    await expect(event(users.owner, id, 'deposited', TODAY, caisseId)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(event(users.owner, id, 'deposited', TODAY, null)).rejects.toMatchObject({ code: '23514' });
    await event(users.owner, id, 'deposited', '2026-06-05', bankId);
    await expect(event(users.owner, id, 'cleared', '2026-06-04', bankId)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(event(users.owner, id, 'cleared', '2026-06-06', caisseId)).rejects.toMatchObject({
      code: '23514',
    });
    const cash = await receiveInstrument(
      app,
      users.owner,
      { method: 'cash', amountCentimes: 100, clientId },
      { today: TODAY },
    );
    expect(cash.ok).toBe(true);
  });

  it('a first event must be dated the day of receipt', async () => {
    await expect(
      inCtx(users.owner, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into payment_instrument (id, direction, method, amount_centimes, client_id, received_date, created_by)
           values ($1, 'in', 'transfer', 100, $2, $3, $4)`,
          [id, clientId, TODAY, users.owner.id],
        );
        await tx.query(
          `insert into instrument_event (id, instrument_id, event, at_date, created_by) values (gen_random_uuid(), $1, 'received', '2026-06-09', $2)`,
          [id, users.owner.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cancelling needs a reason, ends the instrument, and a cleared instrument cannot be cancelled', async () => {
    const id = await receive();
    expect(await cancelInstrument(app, users.owner, { instrumentId: id, reason: ' ', date: TODAY })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      (await cancelInstrument(app, users.owner, { instrumentId: id, reason: 'saisi deux fois', date: TODAY }))
        .ok,
    ).toBe(true);
    expect(
      await clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: TODAY }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
    const cash = await receiveInstrument(
      app,
      users.owner,
      { method: 'cash', amountCentimes: 100, clientId },
      { today: TODAY },
    );
    if (!cash.ok) throw new Error('setup');
    expect(
      await cancelInstrument(app, users.owner, {
        instrumentId: cash.value.id,
        reason: 'erreur',
        date: TODAY,
      }),
    ).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
  });

  it('two clearings at once: exactly one wins and one movement exists', async () => {
    const id = await receive();
    await event(users.owner, id, 'deposited', TODAY, bankId);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        clearInstrument(app, users.owner, { instrumentId: id, accountId: bankId, date: TODAY }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await movements(id)).toHaveLength(1);
  });

  it('an unknown instrument is NOT_FOUND', async () => {
    expect(
      await clearInstrument(app, users.owner, { instrumentId: randomUUID(), accountId: bankId, date: TODAY }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('who may do what', () => {
  it('office can record receipt, issue and a same-day cash clearing and nothing else, even with direct SQL', async () => {
    const id = await receive();
    await expect(event(users.office, id, 'deposited', TODAY, bankId)).rejects.toThrow();
    await expect(event(users.office, id, 'cancelled', TODAY, null, 'x')).rejects.toThrow();
    const transfer = await receiveInstrument(
      app,
      users.office,
      { method: 'transfer', amountCentimes: 100, clientId },
      { today: TODAY },
    );
    if (!transfer.ok) throw new Error('setup');
    await expect(event(users.office, transfer.value.id, 'cleared', TODAY, bankId)).rejects.toThrow();
  });

  it.each(['office', 'partner', 'plant', 'support'] as const)(
    '%s cannot clear or cancel through the service',
    async (role) => {
      const id = await receive();
      await expect(
        clearInstrument(app, users[role], { instrumentId: id, accountId: bankId, date: TODAY }),
      ).rejects.toThrow();
      await expect(
        cancelInstrument(app, users[role], { instrumentId: id, reason: 'test', date: TODAY }),
      ).rejects.toThrow();
    },
  );

  it.each(['office', 'partner', 'plant', 'support'] as const)(
    '%s cannot write a movement directly',
    async (role) => {
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, created_by)
           values (gen_random_uuid(), $1, 100, $2, 'instrument', gen_random_uuid(), $3)`,
            [caisseId, TODAY, users[role].id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('nobody, the owner included, can edit or delete an instrument, an event or a movement', async () => {
    for (const sql of [
      'update payment_instrument set amount_centimes = 1',
      'delete from payment_instrument',
      `update instrument_event set reason = 'x'`,
      'delete from instrument_event',
      'update money_movement set amount_centimes = 1',
      'delete from money_movement',
      'truncate money_movement',
    ])
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  });

  it('office, partner and plant cannot list; owner and support can, with the state and the early flag', async () => {
    for (const role of ['office', 'partner', 'plant'] as const)
      await expect(listInstruments(app, users[role])).rejects.toThrow();
    const future = await receive({ writtenDate: '2026-07-01', number: `F${randomUUID().slice(0, 8)}` });
    await event(users.owner, future, 'deposited', TODAY, bankId);
    for (const role of ['owner', 'support'] as const) {
      const found = (await listInstruments(app, users[role])).find((i) => i.id === future);
      expect(found).toMatchObject({
        state: 'deposited',
        postDated: true,
        amountCentimes: 500_000,
        writtenDate: '2026-07-01',
      });
      expect(found?.events.map((e) => [e.event, e.early])).toEqual([
        ['received', false],
        ['deposited', true],
      ]);
    }
    const dated = await receive({ writtenDate: '2026-06-20', number: `G${randomUUID().slice(0, 8)}` });
    expect((await listInstruments(app, users.owner)).find((i) => i.id === dated)?.postDated).toBe(true);
  });
});

describe('reversing a movement (a clearing entered by mistake)', () => {
  it('the owner reverses it once, with a reason; the pair nets to zero', async () => {
    const original = await newCashMovement(app, users.owner.id, marker, clientId, 70_000);
    expect(
      (
        await reverseMovement(
          app,
          users.owner,
          { movementId: original.id, reason: 'saisi en double' },
          { today: TODAY },
        )
      ).ok,
    ).toBe(true);
    const sum = await inCtx(users.owner, (tx) =>
      tx.query<{ s: string }>(
        `select sum(amount_centimes)::text as s from money_movement where id = $1 or reverses_id = $1`,
        [original.id],
      ),
    );
    expect(sum.rows[0]?.s).toBe('0');
    expect(
      await reverseMovement(
        app,
        users.owner,
        { movementId: original.id, reason: 'encore' },
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'CONFLICT' });
    expect(
      await reverseMovement(app, users.owner, { movementId: randomUUID(), reason: 'x' }, { today: TODAY }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(
      await reverseMovement(app, users.owner, { movementId: original.id, reason: '' }, { today: TODAY }),
    ).toEqual({ ok: false, error: 'INVALID' });
  });

  it('the database refuses a reversal that does not negate exactly, a reversal of a reversal, and anyone but the owner', async () => {
    const original = await newCashMovement(app, users.owner.id, marker, clientId, 55_000);
    const insert = (actor: SessionUser, amount: number, reverses: string, source: string = reverses) =>
      inCtx(actor, (tx) =>
        tx.query(
          `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, reverses_id, reason, created_by)
           values (gen_random_uuid(), $1, $2, $3, 'reversal', $4, $5, 'test', $6)`,
          [original.accountId, amount, TODAY, source, reverses, actor.id],
        ),
      );
    await expect(insert(users.owner, -54_999, original.id)).rejects.toMatchObject({ code: '23514' });
    for (const role of ['office', 'partner', 'plant', 'support'] as const)
      await expect(insert(users[role], -55_000, original.id)).rejects.toMatchObject({ code: '42501' });
    await insert(users.owner, -55_000, original.id);
    const reversal = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>(`select id from money_movement where reverses_id = $1`, [original.id]),
    );
    await expect(insert(users.owner, 55_000, reversal.rows[0]?.id as string)).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('partner, office, plant and support cannot reverse through the service', async () => {
    const original = await newCashMovement(app, users.owner.id, marker, clientId, 11_000);
    for (const role of ['office', 'partner', 'plant', 'support'] as const)
      await expect(
        reverseMovement(app, users[role], { movementId: original.id, reason: 'test' }, { today: TODAY }),
      ).rejects.toThrow();
  });
});

describe('visibility (AC-SEC-04/05 for the three tables lives in tests/rls and tests/money-visibility)', () => {
  it('an instrument entered by office is invisible to it, partner and plant', async () => {
    await receive();
    for (const role of ['office', 'partner', 'plant'] as const) {
      for (const table of ['payment_instrument', 'instrument_event', 'money_movement']) {
        const { rows } = await inCtx(users[role], (tx) => tx.query(`select 1 from ${table}`));
        expect(rows, `${role} ${table}`).toEqual([]);
      }
    }
    expect(INSTRUMENT_EVENTS.length).toBeGreaterThan(0);
  });

  it('default_cash_account is refused to partner, plant and support', async () => {
    for (const role of ['partner', 'plant', 'support'] as const)
      await expect(
        inCtx(users[role], (tx) => tx.query('select public.default_cash_account()')),
      ).rejects.toMatchObject({ code: '42501' });
  });
});
