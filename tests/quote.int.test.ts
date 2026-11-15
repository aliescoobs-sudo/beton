import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createOrder, createQuote, getQuote, listQuotes } from '../src/modules/ledger';
import {
  archiveClient,
  createClient,
  createConcreteType,
  createListPrice,
  fieldCipherFrom,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L31: AC-LED-23. A quote prices a volume at the price in force, has no payment plan and no ledger effect, and becomes
// an order only when a human saves the order form made from it (the order then points at the quote, once).
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
  const type = await createConcreteType(app, users.owner, { code: `Q${rand()}`, label: 'Béton devis' });
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
    { name: `Client devis ${rand()}`, kind: 'company' },
    deps,
  );
  if (!client.ok) throw new Error(client.error);
  return { typeId: type.value.id, clientId: client.value.client.id };
}
const count = async (table: 'sales_order' | 'payment_plan_item') =>
  Number(
    (await inCtx(users.owner, (tx) => tx.query<{ n: string }>(`select count(*)::text as n from ${table}`)))
      .rows[0]?.n,
  );

describe('createQuote (AC-LED-23)', () => {
  it('prices at the price in force, valid 30 days, DV number, no order and no plan; office learns no amount', async () => {
    const s = await scene();
    const ordersBefore = await count('sales_order');
    const itemsBefore = await count('payment_plan_item');
    const r = await createQuote(
      app,
      users.office,
      { clientId: s.clientId, concreteTypeId: s.typeId, volumeL: 10_000 },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.code).toMatch(/^DV-2026-\d{5}$/);
    expect(JSON.stringify(r.value)).not.toMatch(/amountCentimes|936000|78000/);
    expect(r.value.effects).toEqual([{ kind: 'document', document: 'quote', code: r.value.code }]);
    expect(await count('sales_order')).toBe(ordersBefore);
    expect(await count('payment_plan_item')).toBe(itemsBefore);
    const q = await getQuote(app, users.owner, r.value.id);
    expect(q).toMatchObject({
      unitPriceHtCentimes: 78_000,
      totalHtCentimes: 780_000,
      totalVatCentimes: 156_000,
      totalTtcCentimes: 936_000,
      quoteDate: TODAY,
      validUntil: '2026-07-01',
      convertedOrderCode: null,
    });
  });

  it('refuses an archived client, and the database refuses a quote at another price', async () => {
    const s = await scene();
    expect(await archiveClient(app, users.owner, s.clientId)).toEqual({ ok: true, value: true });
    expect(
      await createQuote(
        app,
        users.owner,
        { clientId: s.clientId, concreteTypeId: s.typeId, volumeL: 10_000 },
        { today: TODAY },
      ),
    ).toEqual({
      ok: false,
      error: 'CLIENT_ARCHIVED',
    });
    const fresh = await scene();
    const price = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>('select id from selling_price where concrete_type_id = $1', [fresh.typeId]),
      )
    ).rows[0]?.id;
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into quote (id, code, client_id, concrete_type_id, volume_l, quote_date, valid_until, selling_price_id,
                              unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), public.next_doc_number('DV', 2026, 5), $1, $2, 10000, $3, '2026-07-01', $4, 70000, 2000, 700000, 140000, 840000, $5)`,
          [fresh.clientId, fresh.typeId, TODAY, price, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('converting a quote to an order (AC-LED-23)', () => {
  it('the order saved from the quote points at it, once; the quote then shows its order', async () => {
    const s = await scene();
    const q = await createQuote(
      app,
      users.owner,
      { clientId: s.clientId, concreteTypeId: s.typeId, volumeL: 10_000 },
      { today: TODAY },
    );
    if (!q.ok) throw new Error(q.error);
    const order = {
      clientId: s.clientId,
      concreteTypeId: s.typeId,
      dischargeMethod: 'GOULOTTE',
      volumeL: 10_000,
      deliveryDate: '2026-06-05',
      plan: { preset: 'cash' },
      quoteId: q.value.id,
    };
    const made = await createOrder(app, users.owner, order, { today: TODAY });
    if (!made.ok) throw new Error(made.error);
    expect((await getQuote(app, users.owner, q.value.id))?.convertedOrderCode).toBe(made.value.code);
    expect(await createOrder(app, users.owner, order, { today: TODAY })).toEqual({
      ok: false,
      error: 'CONFLICT',
    });
    // Another client's quote is not this order's quote.
    const other = await scene();
    expect(
      await createOrder(
        app,
        users.owner,
        { ...order, clientId: other.clientId, concreteTypeId: other.typeId },
        { today: TODAY },
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('visibility (DECISIONS 81)', () => {
  it('office, partner and plant read no quote; owner and support do; no UPDATE or DELETE exists', async () => {
    const s = await scene();
    const q = await createQuote(
      app,
      users.office,
      { clientId: s.clientId, concreteTypeId: s.typeId, volumeL: 4000 },
      { today: TODAY },
    );
    if (!q.ok) throw new Error(q.error);
    for (const role of ['office', 'partner', 'plant'] as const) {
      expect((await inCtx(users[role], (tx) => tx.query('select 1 from quote'))).rows, role).toEqual([]);
      await expect(listQuotes(app, users[role])).rejects.toBeDefined();
    }
    expect((await listQuotes(app, users.support)).some((x) => x.id === q.value.id)).toBe(true);
    expect((await listQuotes(app, users.owner)).some((x) => x.id === q.value.id)).toBe(true);
    await expect(
      inCtx(users.owner, (tx) => tx.query('update quote set volume_l = 1 where id = $1', [q.value.id])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inCtx(users.owner, (tx) => tx.query('delete from quote where id = $1', [q.value.id])),
    ).rejects.toMatchObject({ code: '42501' });
    expect(randomUUID()).toBeTruthy();
  });
});
