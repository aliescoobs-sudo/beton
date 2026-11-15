import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { cancelOrder, createOrder } from '../src/modules/ledger';
import {
  createClient,
  createConcreteType,
  createListPrice,
  fieldCipherFrom,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { setParameter } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L5: AC-LED-03 (orders: no delete path, cancel = reversing row + audited reason), AC-LED-17 (window, reworded
// by DECISIONS 81: only the owner reverses), reversal pattern invariants in the database.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const rand = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const TODAY = '2026-06-01';

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function scene() {
  const type = await createConcreteType(app, users.owner, { code: `V${rand()}`, label: 'Béton annulation' });
  if (!type.ok) throw new Error(type.error);
  const list = await createListPrice(app, users.owner, {
    concreteTypeId: type.value.id,
    priceHtPerM3Centimes: 78_000,
    effectiveFrom: '2026-01-01',
  });
  if (!list.ok) throw new Error(list.error);
  const client = await createClient(
    app,
    users.office,
    { name: `Client annulation ${rand()}`, kind: 'company' },
    deps,
  );
  if (!client.ok) throw new Error(client.error);
  return { typeId: type.value.id, clientId: client.value.client.id };
}

const orderInput = (
  s: { typeId: string; clientId: string },
  volumeL = 120_000,
  preset = 'installments3',
) => ({
  clientId: s.clientId,
  concreteTypeId: s.typeId,
  dischargeMethod: 'GOULOTTE',
  volumeL,
  deliveryDate: '2026-06-15',
  plan: { preset },
});

async function newOrder(s: Awaited<ReturnType<typeof scene>>, volumeL?: number) {
  const made = await createOrder(app, users.office, orderInput(s, volumeL), { today: TODAY });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const rows = (sql: string, params: unknown[] = []) =>
  inCtx(users.owner, (tx) => tx.query(sql, params)).then((r) => r.rows);

describe('cancelOrder (AC-LED-03)', () => {
  it('inserts a reversing order and negated items; the original is untouched; one audit event carries the reason', async () => {
    const s = await scene();
    const order = await newOrder(s);
    const before = (await rows('select * from sales_order where id = $1', [order.id]))[0];
    const cancelled = await cancelOrder(
      app,
      users.owner,
      order.id,
      'Client a changé de chantier',
      {},
      { today: TODAY },
    );
    if (!cancelled.ok) throw new Error(cancelled.error);
    expect(cancelled.value.replacement).toBeNull();

    const reversal = (
      await rows('select * from sales_order where id = $1', [cancelled.value.reversal.id])
    )[0];
    expect(reversal).toMatchObject({
      reverses_id: order.id,
      reason: 'Client a changé de chantier',
      volume_l: -120_000,
      total_ht_centimes: '-9360000',
      total_vat_centimes: '-1872000',
      total_ttc_centimes: '-11232000',
      client_id: s.clientId,
      created_by: users.owner.id,
    });
    expect(reversal.code).toMatch(/^CMD-2026-\d{5,}$/);
    expect(reversal.code).not.toBe(order.code);
    // The original row is exactly as it was.
    expect((await rows('select * from sales_order where id = $1', [order.id]))[0]).toEqual(before);

    const items = await rows(
      'select amount_centimes, reverses_id, order_id from payment_plan_item where order_id = $1 order by seq',
      [cancelled.value.reversal.id],
    );
    const originals = await rows(
      'select id, amount_centimes from payment_plan_item where order_id = $1 order by seq',
      [order.id],
    );
    expect(items.map((i) => i.amount_centimes)).toEqual(
      originals.map((i) => String(-Number(i.amount_centimes))),
    );
    expect(items.map((i) => i.reverses_id)).toEqual(originals.map((i) => i.id));

    // The books net to zero for this order and its reversal.
    const net = (
      await rows(`select sum(total_ttc_centimes) as t from sales_order where id = $1 or reverses_id = $1`, [
        order.id,
      ])
    )[0];
    expect(net.t).toBe('0');

    const audit = await rows(
      `select reason, before, after from audit_event where action = 'reverse' and table_name = 'sales_order' and row_id = $1`,
      [cancelled.value.reversal.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'Client a changé de chantier', before: { reverses: order.id } });
  });

  it('refuses a second cancellation and the cancellation of a reversal; a reason is mandatory', async () => {
    const s = await scene();
    const order = await newOrder(s);
    expect(await cancelOrder(app, users.owner, order.id, '', {}, { today: TODAY })).toEqual({
      ok: false,
      error: 'REASON_REQUIRED',
    });
    expect(await cancelOrder(app, users.owner, order.id, ' ab ', {}, { today: TODAY })).toEqual({
      ok: false,
      error: 'REASON_REQUIRED',
    });
    const first = await cancelOrder(app, users.owner, order.id, 'Erreur de saisie', {}, { today: TODAY });
    if (!first.ok) throw new Error(first.error);
    expect(await cancelOrder(app, users.owner, order.id, 'Encore', {}, { today: TODAY })).toEqual({
      ok: false,
      error: 'ALREADY_REVERSED',
    });
    expect(
      await cancelOrder(
        app,
        users.owner,
        first.value.reversal.id,
        'Annuler l’annulation',
        {},
        { today: TODAY },
      ),
    ).toEqual({
      ok: false,
      error: 'CANNOT_REVERSE_REVERSAL',
    });
    expect(await cancelOrder(app, users.owner, randomUUID(), 'Inconnue', {}, { today: TODAY })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await cancelOrder(app, users.owner, 'not-a-uuid', 'Mal formé', {}, { today: TODAY })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('two concurrent cancellations: exactly one wins (unique reverses_id)', async () => {
    const s = await scene();
    const order = await newOrder(s);
    const results = await Promise.all([
      cancelOrder(app, users.owner, order.id, 'Premier', {}, { today: TODAY }),
      cancelOrder(app, users.owner, order.id, 'Second', {}, { today: TODAY }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: 'ALREADY_REVERSED' });
    expect(await rows('select 1 from sales_order where reverses_id = $1', [order.id])).toHaveLength(1);
  });

  it('a replacement order is created in the same transaction; an invalid replacement writes nothing at all', async () => {
    const s = await scene();
    const order = await newOrder(s);
    const bad = await cancelOrder(
      app,
      users.owner,
      order.id,
      'Corriger',
      { replacement: { nope: 1 } },
      { today: TODAY },
    );
    expect(bad).toEqual({ ok: false, error: 'INVALID' });
    const badPlan = await cancelOrder(
      app,
      users.owner,
      order.id,
      'Corriger',
      { replacement: { ...orderInput(s, 60_000), clientId: randomUUID() } },
      { today: TODAY },
    );
    expect(badPlan).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await rows('select 1 from sales_order where reverses_id = $1', [order.id])).toHaveLength(0);

    const done = await cancelOrder(
      app,
      users.owner,
      order.id,
      'Volume corrigé',
      { replacement: orderInput(s, 60_000, 'cash') },
      { today: TODAY },
    );
    if (!done.ok) throw new Error(done.error);
    expect(done.value.replacement?.code).toMatch(/^CMD-2026-/);
    const replacement = (
      await rows('select volume_l, reverses_id, total_ttc_centimes from sales_order where id = $1', [
        done.value.replacement?.id,
      ])
    )[0];
    expect(replacement).toMatchObject({ volume_l: 60_000, reverses_id: null, total_ttc_centimes: '5616000' });
  });

  it('the derived is_reversed shows on the operational view for partner and plant, never stored', async () => {
    const s = await scene();
    const order = await newOrder(s);
    const state = async (role: 'partner' | 'plant') =>
      (
        await inCtx(users[role], (tx) =>
          tx.query('select id, is_reversed from sales_order_ops where id = $1', [order.id]),
        )
      ).rows[0];
    expect(await state('partner')).toMatchObject({ is_reversed: false });
    await cancelOrder(app, users.owner, order.id, 'Annulée', {}, { today: TODAY });
    expect(await state('partner')).toMatchObject({ is_reversed: true });
    expect(await state('plant')).toMatchObject({ is_reversed: true });
  });
});

describe('who may reverse (DECISIONS 81) and the window (AC-LED-17)', () => {
  it('office, partner, plant and support are refused by the service and by direct SQL under RLS', async () => {
    const s = await scene();
    const order = await newOrder(s);
    const original = (await rows('select * from sales_order where id = $1', [order.id]))[0];
    for (const role of ['office', 'partner', 'plant', 'support'] as const) {
      await expect(
        cancelOrder(app, users[role], order.id, 'Annulation', {}, { today: TODAY }),
        role,
      ).rejects.toThrow('Forbidden');
      // A literal reversal row: these roles cannot read the original, so the values come from the owner's read.
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
               unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reverses_id, reason, created_by)
             values (gen_random_uuid(), 'CMD-2026-88888', $1, $2, -120000, '2026-06-01', '2026-06-15', $3, 78000, 2000,
                     -9360000, -1872000, -11232000, $4, 'x', $5)`,
            [
              original.client_id,
              original.concrete_type_id,
              original.selling_price_id,
              order.id,
              users[role].id,
            ],
          ),
        ),
        role,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the owner can reverse an entry older than the window; the parameter is honoured', async () => {
    const s = await scene();
    const order = await newOrder(s);
    await setParameter(app, users.owner, 'reversal_window_days', 0);
    try {
      expect(
        await cancelOrder(app, users.owner, order.id, 'Très ancienne', {}, { today: '2026-06-30' }),
      ).toMatchObject({ ok: true });
    } finally {
      await setParameter(app, users.owner, 'reversal_window_days', 2);
    }
  });
});

describe('the database guards the reversal pattern even for direct SQL', () => {
  const insertReversal = (originalId: string, over: Record<string, string> = {}) =>
    inCtx(users.owner, async (tx) => {
      const id = randomUUID();
      await tx.query(
        `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
           unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reverses_id, reason, created_by)
         select $1, 'CMD-2026-7' || floor(random()*9000+1000)::int, client_id, concrete_type_id, -volume_l, order_date, delivery_date,
           selling_price_id, unit_price_ht_centimes, vat_rate_bp, ${over.ht ?? '-total_ht_centimes'}, ${over.vat ?? '-total_vat_centimes'},
           ${over.ttc ?? '-total_ttc_centimes'}, id, ${over.reason ?? "'raison'"}, $2
           from sales_order where id = $3`,
        [id, users.owner.id, originalId],
      );
      await tx.query(
        `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, reverses_id, created_by)
         select gen_random_uuid(), $1, seq, direction, method, due_date, -amount_centimes, id, $2 from payment_plan_item where order_id = $3`,
        [id, users.owner.id, originalId],
      );
      return id;
    });

  it('a reversal that does not negate the original exactly is refused', async () => {
    const s = await scene();
    const order = await newOrder(s);
    await expect(insertReversal(order.id, { ttc: '-total_ttc_centimes - 1' })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('a reversal without a reason is refused (CHECK)', async () => {
    const s = await scene();
    const order = await newOrder(s);
    // The policy (reason required) and the CHECK both say no.
    await expect(insertReversal(order.id, { reason: 'null' })).rejects.toMatchObject({
      code: expect.stringMatching(/^(42501|23514)$/),
    });
  });

  it('a second reversal row for the same order is refused (unique), as is reversing a reversal', async () => {
    const s = await scene();
    const order = await newOrder(s);
    const reversalId = await insertReversal(order.id);
    await expect(insertReversal(order.id)).rejects.toMatchObject({ code: '23505' });
    await expect(insertReversal(reversalId)).rejects.toMatchObject({ code: '23514' });
  });

  it('reversal items must negate their original items exactly', async () => {
    const s = await scene();
    const order = await newOrder(s);
    await expect(
      inCtx(users.owner, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
             unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reverses_id, reason, created_by)
           select $1, 'CMD-2026-66666', client_id, concrete_type_id, -volume_l, order_date, delivery_date, selling_price_id,
             unit_price_ht_centimes, vat_rate_bp, -total_ht_centimes, -total_vat_centimes, -total_ttc_centimes, id, 'x', $2
             from sales_order where id = $3`,
          [id, users.owner.id, order.id],
        );
        // One item for the whole total instead of the three negated ones.
        await tx.query(
          `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, reverses_id, created_by)
           select gen_random_uuid(), $1, 1, 'in', method, due_date, -11232000, id, $2 from payment_plan_item where order_id = $3 order by seq limit 1`,
          [id, users.owner.id, order.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
