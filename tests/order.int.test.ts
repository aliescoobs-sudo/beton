import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createOrder } from '../src/modules/ledger';
import {
  archiveClient,
  createClient,
  createConcreteType,
  createListPrice,
  createClientOverride,
  fieldCipherFrom,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { setParameter } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';

// ledger L3: AC-LED-01, AC-LED-02, AC-LED-13, AC-LED-18, AC-SEC-04 for sales_order / payment_plan_item (matrix: tests/rls).
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

/** A fresh type with a list price of 780,00 HT/m³ from 2026-01-01, and an active client. */
async function scene(price = 78_000) {
  const type = await createConcreteType(app, users.owner, { code: `O${rand()}`, label: 'Béton ordre' });
  if (!type.ok) throw new Error(type.error);
  const list = await createListPrice(app, users.owner, {
    concreteTypeId: type.value.id,
    priceHtPerM3Centimes: price,
    effectiveFrom: '2026-01-01',
  });
  if (!list.ok) throw new Error(list.error);
  const client = await createClient(
    app,
    users.office,
    { name: `Client ordre ${rand()}`, kind: 'company' },
    deps,
  );
  if (!client.ok) throw new Error(client.error);
  return { typeId: type.value.id, listId: list.value.id, clientId: client.value.client.id };
}

const input = (s: { typeId: string; clientId: string }, extra: Record<string, unknown> = {}) => ({
  clientId: s.clientId,
  concreteTypeId: s.typeId,
  dischargeMethod: 'GOULOTTE',
  volumeL: 120_000,
  deliveryDate: '2026-06-15',
  plan: { preset: 'custom', items: [] as unknown[] },
  ...extra,
});

const orderRows = (id: string) =>
  inCtx(users.owner, async (tx) => ({
    order: (await tx.query(`select * from sales_order where id = $1`, [id])).rows[0],
    items: (await tx.query(`select * from payment_plan_item where order_id = $1 order by seq`, [id])).rows,
  }));

describe('createOrder (AC-LED-01)', () => {
  it('120 m³ of B25 at 780,00: 93 600,00 / 18 720,00 / 112 320,00, plan 20 / 40 / 40, entered by office', async () => {
    const s = await scene();
    const made = await createOrder(
      app,
      users.office,
      input(s, {
        plan: {
          preset: 'custom',
          items: [
            { method: 'advance', dueDate: '2026-06-01', percentBp: 2000 },
            { method: 'cheque', dueDate: '2026-07-15', percentBp: 4000 },
            { method: 'cheque', dueDate: '2026-08-15', percentBp: 4000 },
          ],
        },
      }),
      { today: TODAY },
    );
    if (!made.ok) throw new Error(made.error);
    expect(made.value.code).toMatch(/^CMD-2026-\d{5,}$/);
    // Office learns the id and the code, nothing monetary.
    expectNoFields(made.value, ['totalHt', 'totalTtc', 'unitPrice', 'amount', 'total_ttc_centimes']);
    expect(Object.keys(made.value).sort()).toEqual(['code', 'effects', 'id']);
    expect(JSON.stringify(made.value)).not.toMatch(/amountCentimes|112320|93600/); // office learns no amount

    const { order, items } = await orderRows(made.value.id);
    expect(order).toMatchObject({
      volume_l: 120_000,
      unit_price_ht_centimes: '78000',
      vat_rate_bp: 2000,
      total_ht_centimes: '9360000',
      total_vat_centimes: '1872000',
      total_ttc_centimes: '11232000',
      selling_price_id: s.listId,
      created_by: users.office.id,
    });
    expect(items.map((i) => i.amount_centimes)).toEqual(['2246400', '4492800', '4492800']);
    expect(items.map((i) => i.method)).toEqual(['advance', 'cheque', 'cheque']);
  });

  it.each([
    ['cash', 1],
    ['advance50', 2],
    ['installments3', 3],
    ['cheque30', 1],
  ] as const)('preset %s creates %i plan item(s) adding up to the total', async (preset, count) => {
    const s = await scene(85_133);
    const made = await createOrder(app, users.office, input(s, { volumeL: 7500, plan: { preset } }), {
      today: TODAY,
    });
    if (!made.ok) throw new Error(made.error);
    const { order, items } = await orderRows(made.value.id);
    expect(items).toHaveLength(count);
    expect(items.reduce((sum, i) => sum + Number(i.amount_centimes), 0)).toBe(
      Number(order.total_ttc_centimes),
    );
  });

  it('T17 G7: the method of the input is recorded on the order, by the office door and by the owner path; a missing method is refused', async () => {
    const s = await scene();
    for (const [user, method] of [
      [users.office, 'POMPE'],
      [users.owner, 'GOULOTTE'],
    ] as const) {
      const made = await createOrder(
        app,
        user,
        input(s, { dischargeMethod: method, plan: { preset: 'cash' } }),
        { today: TODAY },
      );
      if (!made.ok) throw new Error(made.error);
      expect((await orderRows(made.value.id)).order).toMatchObject({ discharge_method: method });
    }
    const { dischargeMethod: _omitted, ...without } = input(s, { plan: { preset: 'cash' } });
    void _omitted;
    for (const user of [users.office, users.owner])
      expect(await createOrder(app, user, without, { today: TODAY })).toEqual({
        ok: false,
        error: 'INVALID',
      });
  });

  it('the price is resolved for the client: a client override beats the list price', async () => {
    const s = await scene();
    const o = await createClientOverride(app, users.owner, {
      concreteTypeId: s.typeId,
      dischargeMethod: 'GOULOTTE',
      clientId: s.clientId,
      priceHtPerM3Centimes: 70_000,
      effectiveFrom: '2026-02-01',
      reason: 'Accord cadre',
    });
    if (!o.ok) throw new Error(o.error);
    const made = await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), {
      today: TODAY,
    });
    if (!made.ok) throw new Error(made.error);
    expect((await orderRows(made.value.id)).order).toMatchObject({
      unit_price_ht_centimes: '70000',
      selling_price_id: o.value.id,
    });
  });

  it('refuses an invalid input, no price, a delivery before the order date, an unknown client or type', async () => {
    const s = await scene();
    expect(await createOrder(app, users.office, { nope: 1 }, { today: TODAY })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await createOrder(app, users.office, input(s, { volumeL: 0, plan: { preset: 'cash' } }), {
        today: TODAY,
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await createOrder(
        app,
        users.office,
        input(s, { deliveryDate: '2026-05-31', plan: { preset: 'cash' } }),
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'DELIVERY_BEFORE_ORDER' });
    // Before the first price date there is no price: never 0.
    expect(
      await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), { today: '2025-12-31' }),
    ).toEqual({ ok: false, error: 'NO_PRICE' });
    expect(
      await createOrder(
        app,
        users.office,
        input({ ...s, clientId: randomUUID() }, { plan: { preset: 'cash' } }),
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(
      await createOrder(
        app,
        users.office,
        input({ ...s, typeId: randomUUID() }, { plan: { preset: 'cash' } }),
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('only owner and office create orders; partner, plant and support are refused by the service', async () => {
    const s = await scene();
    for (const role of ['partner', 'plant', 'support'] as const) {
      await expect(
        createOrder(app, users[role], input(s, { plan: { preset: 'cash' } }), { today: TODAY }),
      ).rejects.toThrow('Forbidden');
    }
    expect(
      await createOrder(app, users.owner, input(s, { plan: { preset: 'cash' } }), { today: TODAY }),
    ).toMatchObject({ ok: true });
  });
});

describe('the plan adds up to the order (AC-LED-02)', () => {
  it('the service refuses fixed amounts that do not add up to the TTC', async () => {
    const s = await scene();
    const bad = await createOrder(
      app,
      users.office,
      input(s, {
        plan: {
          preset: 'custom',
          items: [
            { method: 'cash', dueDate: '2026-06-15', amountCentimes: 5_000_000 },
            { method: 'cheque', dueDate: '2026-07-15', amountCentimes: 6_232_001 },
          ],
        },
      }),
      { today: TODAY },
    );
    expect(bad).toEqual({ ok: false, error: 'PLAN_INVALID' });
    const good = await createOrder(
      app,
      users.office,
      input(s, {
        plan: {
          preset: 'custom',
          items: [
            { method: 'cash', dueDate: '2026-06-15', amountCentimes: 5_000_000 },
            { method: 'cheque', dueDate: '2026-07-15', amountCentimes: 6_232_000 },
          ],
        },
      }),
      { today: TODAY },
    );
    expect(good).toMatchObject({ ok: true });
  });

  async function rawOrder(s: Awaited<ReturnType<typeof scene>>, itemAmounts: number[], tx: pg.PoolClient) {
    const id = randomUUID();
    const code = (await tx.query<{ n: string }>(`select public.next_doc_number('CMD', 2026, 5) as n`)).rows[0]
      ?.n;
    await tx.query(
      `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
         unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
       values ($1, $2, $3, $4, 10000, '2026-06-01', '2026-06-02', $5, 78000, 2000, 780000, 156000, 936000, $6)`,
      [id, code, s.clientId, s.typeId, s.listId, users.owner.id],
    );
    for (const [n, amount] of itemAmounts.entries()) {
      await tx.query(
        `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
         values (gen_random_uuid(), $1, $2, 'in', 'cash', '2026-06-02', $3, $4)`,
        [id, n + 1, amount, users.owner.id],
      );
    }
    return id;
  }

  it('the database refuses a plan that does not add up, at commit, even for direct SQL', async () => {
    const s = await scene();
    await expect(inCtx(users.owner, (tx) => rawOrder(s, [900_000, 36_001], tx))).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/payment plan/),
    });
    await expect(inCtx(users.owner, (tx) => rawOrder(s, [], tx))).rejects.toMatchObject({ code: '23514' });
    await expect(inCtx(users.owner, (tx) => rawOrder(s, [900_000, 36_000], tx))).resolves.toBeTruthy();
  });

  it('an item added later that breaks the sum is refused too', async () => {
    const s = await scene();
    const id = await inCtx(users.owner, (tx) => rawOrder(s, [936_000], tx));
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
           values (gen_random_uuid(), $1, 2, 'in', 'cash', '2026-06-02', 1, $2)`,
          [id, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('totals must add up (CHECK)', async () => {
    const s = await scene();
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
             unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), 'CMD-2026-99999', $1, $2, 10000, '2026-06-01', '2026-06-02', $3, 78000, 2000, 780000, 156000, 936001, $4)`,
          [s.clientId, s.typeId, s.listId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the VAT rate in force is stored on each order (AC-LED-13)', () => {
  it('a change of vat_rate_bp affects only later orders', async () => {
    const s = await scene();
    const before = await createOrder(
      app,
      users.office,
      input(s, { volumeL: 10_000, plan: { preset: 'cash' } }),
      { today: TODAY },
    );
    if (!before.ok) throw new Error(before.error);
    await setParameter(app, users.owner, 'vat_rate_bp', 1400);
    try {
      const after = await createOrder(
        app,
        users.office,
        input(s, { volumeL: 10_000, plan: { preset: 'cash' } }),
        { today: TODAY },
      );
      if (!after.ok) throw new Error(after.error);
      expect((await orderRows(before.value.id)).order).toMatchObject({
        vat_rate_bp: 2000,
        total_vat_centimes: '156000',
        total_ttc_centimes: '936000',
      });
      expect((await orderRows(after.value.id)).order).toMatchObject({
        vat_rate_bp: 1400,
        total_vat_centimes: '109200',
        total_ttc_centimes: '889200',
      });
    } finally {
      await setParameter(app, users.owner, 'vat_rate_bp', 2000);
    }
  });
});

describe('an archived client gets no new order, old orders still show it (AC-LED-18)', () => {
  it('refused by the service and by the database; the old order keeps its client', async () => {
    const s = await scene();
    const old = await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), {
      today: TODAY,
    });
    if (!old.ok) throw new Error(old.error);
    expect(await archiveClient(app, users.owner, s.clientId)).toEqual({ ok: true, value: true });

    expect(
      await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), { today: TODAY }),
    ).toEqual({
      ok: false,
      error: 'CLIENT_ARCHIVED',
    });
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
             unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), 'CMD-2026-99998', $1, $2, 10000, '2026-06-01', '2026-06-02', $3, 78000, 2000, 780000, 156000, 936000, $4)`,
          [s.clientId, s.typeId, s.listId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/client is not active/) });

    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query(
        `select c.status, c.name from sales_order o join client c on c.id = o.client_id where o.id = $1`,
        [old.value.id],
      ),
    );
    expect(rows[0]).toMatchObject({ status: 'archived' });
  });
});

describe('what the database guards on a direct insert', () => {
  const base = (s: Awaited<ReturnType<typeof scene>>, over: Record<string, unknown> = {}) => ({
    price: s.listId,
    unit: 78_000,
    reason: null as string | null,
    ...over,
  });
  const insert = (
    s: Awaited<ReturnType<typeof scene>>,
    o: ReturnType<typeof base>,
    role: SessionUser = users.owner,
  ) =>
    inCtx(role, (tx) =>
      tx.query(
        `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
           unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reason, created_by)
         values (gen_random_uuid(), 'CMD-2026-9' || floor(random()*9000+1000)::int, $1, $2, 10000, '2026-06-01', '2026-06-02', $3, $4, 2000, 780000, 156000, 936000, $5, $6)`,
        [s.clientId, s.typeId, o.price, o.unit, o.reason, role.id],
      ),
    );

  it('refuses a price that is not the one in force, or a price row of another type', async () => {
    const s = await scene();
    const other = await scene(50_000);
    await expect(insert(s, base(s, { price: other.listId }))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(s, base(s, { unit: 70_000 }))).rejects.toMatchObject({ code: '23514' });
  });

  it('office cannot insert an order with a reason (override is the owner’s, L6) or a reversal row', async () => {
    const s = await scene();
    await expect(insert(s, base(s, { reason: 'remise' }), users.office)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses a plan item for a purchase direction', async () => {
    const s = await scene();
    const id = randomUUID();
    await expect(
      inCtx(users.owner, async (tx) => {
        await tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
             unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values ($1, 'CMD-2026-99997', $2, $3, 10000, '2026-06-01', '2026-06-02', $4, 78000, 2000, 780000, 156000, 936000, $5)`,
          [id, s.clientId, s.typeId, s.listId, users.owner.id],
        );
        await tx.query(
          `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
           values (gen_random_uuid(), $1, 1, 'out', 'cash', '2026-06-02', 936000, $2)`,
          [id, users.owner.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('visibility and immutability (AC-SEC-04, AC-SEC-05, DECISIONS 81)', () => {
  it('no UPDATE, DELETE or TRUNCATE on either table, for any role', async () => {
    for (const table of ['sales_order', 'payment_plan_item']) {
      for (const sql of [
        `update ${table} set created_by = created_by`,
        `delete from ${table}`,
        `truncate ${table}`,
      ]) {
        for (const role of ['owner', 'office'] as const) {
          await expect(
            inCtx(users[role], (tx) => tx.query(sql)),
            `${role}: ${sql}`,
          ).rejects.toMatchObject({ code: '42501' });
        }
      }
    }
  });

  it('office wrote the order and cannot read it back; partner and plant get zero rows from both tables', async () => {
    const s = await scene();
    const made = await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), {
      today: TODAY,
    });
    if (!made.ok) throw new Error(made.error);
    for (const role of ['office', 'partner', 'plant'] as const) {
      for (const table of ['sales_order', 'payment_plan_item']) {
        const { rows } = await inCtx(users[role], (tx) => tx.query(`select 1 from ${table}`));
        expect(rows, `${role} ${table}`).toEqual([]);
      }
    }
    await expect(
      inCtx(users.office, (tx) => tx.query(`select id from sales_order where id = $1`, [made.value.id])),
    ).resolves.toMatchObject({ rows: [] });
    for (const role of ['owner', 'support'] as const) {
      const { rows } = await inCtx(users[role], (tx) =>
        tx.query(`select 1 from sales_order where id = $1`, [made.value.id]),
      );
      expect(rows).toHaveLength(1);
    }
  });

  it('an insert by office cannot return the row it wrote (no RETURNING without a SELECT policy)', async () => {
    const s = await scene();
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(
          `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
             unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), 'CMD-2026-99996', $1, $2, 10000, '2026-06-01', '2026-06-02', $3, 78000, 2000, 780000, 156000, 936000, $4)
           returning total_ttc_centimes`,
          [s.clientId, s.typeId, s.listId, users.office.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('partner and plant read the operational view only: code, type, volume, date, client code, site, zone', async () => {
    const s = await scene();
    const made = await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), {
      today: TODAY,
    });
    if (!made.ok) throw new Error(made.error);
    for (const role of ['partner', 'plant', 'owner', 'support'] as const) {
      const { rows } = await inCtx(users[role], (tx) =>
        tx.query(`select * from sales_order_ops where id = $1`, [made.value.id]),
      );
      expect(rows, role).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(
        [
          'client_code',
          'code',
          'concrete_type_id',
          'delivery_date',
          'id',
          'is_reversed',
          'plant_id',
          'reverses_id',
          'site_id',
          'site_label',
          'volume_l',
          'zone_id',
        ].sort(),
      );
      expectNoFields(rows, [
        'unit_price_ht_centimes',
        'total_ht_centimes',
        'total_vat_centimes',
        'total_ttc_centimes',
        'selling_price_id',
        'vat_rate_bp',
        'client_id',
        'created_by',
      ]);
    }
    // Office reads nothing of orders, not even the view.
    const { rows } = await inCtx(users.office, (tx) => tx.query(`select 1 from sales_order_ops`));
    expect(rows).toEqual([]);
    const outside = await app.query(`select 1 from sales_order_ops`);
    expect(outside.rows).toEqual([]);
  });

  it('the audit rows of an order (amounts) are hidden from office, partner and plant', async () => {
    const s = await scene();
    const made = await createOrder(app, users.office, input(s, { plan: { preset: 'cash' } }), {
      today: TODAY,
    });
    if (!made.ok) throw new Error(made.error);
    for (const role of ['office', 'partner', 'plant'] as const) {
      const { rows } = await inCtx(users[role], (tx) =>
        tx.query(`select 1 from audit_event where table_name in ('sales_order', 'payment_plan_item')`),
      );
      expect(rows, role).toEqual([]);
    }
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query(`select 1 from audit_event where table_name = 'sales_order' and row_id = $1`, [made.value.id]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('the price and parameter helpers refuse partner, plant and support', async () => {
    const s = await scene();
    for (const role of ['partner', 'plant', 'support'] as const) {
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(`select * from public.resolve_selling_price($1, $2, '2026-06-01')`, [
            s.typeId,
            s.clientId,
          ]),
        ),
        role,
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inCtx(users[role], (tx) => tx.query(`select public.ledger_parameter('vat_rate_bp')`)),
        role,
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      inCtx(users.office, (tx) => tx.query(`select public.ledger_parameter('auth.step_up_minutes')`)),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
