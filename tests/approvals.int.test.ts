import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  confirmOrderPrice,
  confirmPricesInBulk,
  createInvoice,
  createOrder,
  getClientStandings,
  getInvoiceDocument,
  getOrderApprovalStates,
  listApprovals,
  releaseOrderHold,
  setCreditLimit,
} from '../src/modules/ledger';
import {
  createClient,
  createConcreteType,
  createListPrice,
  fieldCipherFrom,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import type { Role } from '../src/modules/platform-security/domain/permissions';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  clientWithLoads,
  deliveryScene,
  insertDelivery,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// R3 (CP-PROD-PLAN): AC-PROD-15 to 19.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
afterAll(() => Promise.all([app.end(), migrator.end()]));
const marker = `ap${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const rand = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<
  'owner' | 'app_admin' | 'office_sales' | 'office_purchases' | 'office' | 'support' | 'partner',
  SessionUser
>;
const TODAY = '2026-07-03';
let scene: Awaited<ReturnType<typeof deliveryScene>>;
let master: OrderMaster;

async function userOf(role: Role): Promise<SessionUser> {
  return realSessionUser(env.DATABASE_URL_MIGRATOR, role);
}
beforeAll(async () => {
  for (const r of [
    'owner',
    'app_admin',
    'office_sales',
    'office_purchases',
    'office',
    'support',
    'partner',
  ] as const) {
    users[r] = await userOf(r);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
});

/** A fresh type at 780,00 HT/m³ and a client; the order is made by `by`. */
async function freshOrder(by: SessionUser, extra: Record<string, unknown> = {}, today = '2026-06-01') {
  const type = await createConcreteType(app, users.owner, { code: `A${rand()}`, label: 'Béton appr' });
  if (!type.ok) throw new Error(type.error);
  const list = await createListPrice(app, users.owner, {
    concreteTypeId: type.value.id,
    priceHtPerM3Centimes: 78_000,
    effectiveFrom: '2026-01-01',
  });
  if (!list.ok) throw new Error(list.error);
  const client = await createClient(
    app,
    users.owner,
    { name: `Client appr ${rand()}`, kind: 'company' },
    deps,
  );
  if (!client.ok) throw new Error(client.error);
  const make = (clientId: string, deliveryDate: string, t = today) =>
    createOrder(
      app,
      by,
      {
        clientId,
        concreteTypeId: type.value.id,
        volumeL: 10_000,
        deliveryDate,
        plan: { preset: 'cash' },
        ...extra,
      },
      { today: t },
    );
  return { clientId: client.value.client.id, clientCode: client.value.client.code, make };
}
const makeProvisional = (orderId: string, by: string) =>
  withRlsContext(migrator, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query(
      `insert into order_price_status (order_id, provisional_unit_price_centimes, created_by) values ($1, 78000, $2)`,
      [orderId, by],
    ),
  );
const codeOf = (r: Awaited<ReturnType<typeof createOrder>>) => {
  if (!r.ok) throw new Error(r.error);
  return r.value.code;
};
const idOfCode = async (code: string) =>
  (await migrator.query<{ id: string }>('select id from sales_order where code = $1', [code])).rows[0]
    ?.id as string;

describe('provisional price (AC-PROD-15, 16, 17)', () => {
  it('an order made by office_sales is provisional at the reference price; the owner’s is not', async () => {
    const s = await freshOrder(users.office_sales);
    const code = codeOf(await s.make(s.clientId, '2026-06-15'));
    const row = (
      await migrator.query(`select * from order_price_status where order_id = $1`, [await idOfCode(code)])
    ).rows[0];
    expect(Number(row.provisional_unit_price_centimes)).toBe(78_000);
    expect(row.confirmed_at).toBeNull();
    const o = await freshOrder(users.owner);
    const ownerCode = codeOf(await o.make(o.clientId, '2026-06-15'));
    expect(
      (
        await migrator.query(`select 1 from order_price_status where order_id = $1`, [
          await idOfCode(ownerCode),
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('office_purchases cannot create an order', async () => {
    const s = await freshOrder(users.owner);
    await expect(
      s
        .make(s.clientId, '2026-06-15')
        .then(() => freshOrder(users.office_purchases).then((x) => x.make(x.clientId, '2026-06-15'))),
    ).rejects.toThrow(/Forbidden/);
  });

  it('no invoice while the price is provisional; after the owner confirms, the invoice bills the confirmed price', async () => {
    const c = await clientWithLoads(app, users.owner.id, master, scene, [[4000]], { delivered: true });
    const orderId = await idOfCode(c.orders[0]!.code);
    await makeProvisional(orderId, users.office_sales.id);
    const ids = c.orders.flatMap((o) => o.deliveryIds);
    const blocked = await createInvoice(app, users.owner, { deliveryIds: ids }, { today: TODAY });
    expect(blocked.ok).toBe(false);
    // the card is in the inbox with the figures that will be written
    const cards = await listApprovals(app, users.owner);
    const card = cards.find((k) => k.orderId === orderId);
    expect(card).toMatchObject({ kind: 'price', unitPriceCentimes: 78_000 });
    // app_admin confirms a different real price (900,00)
    const done = await confirmOrderPrice(app, users.app_admin, { orderId, unitPriceCentimes: 90_000 });
    expect(done).toEqual({ ok: true, value: { unitPriceCentimes: 90_000 } });
    expect(await confirmOrderPrice(app, users.owner, { orderId })).toEqual({
      ok: false,
      error: 'ALREADY_DONE',
    });
    const inv = await createInvoice(app, users.owner, { deliveryIds: ids }, { today: TODAY });
    if (!inv.ok) throw new Error(inv.error);
    const id = (
      await migrator.query<{ id: string }>('select id from invoice where number = $1', [inv.value.number])
    ).rows[0]!.id;
    const doc = await getInvoiceDocument(app, users.owner, id);
    expect(doc?.lines[0]?.unitPriceHtCentimes).toBe(90_000);
    expect(cards.length).toBeGreaterThan(0);
    expect((await listApprovals(app, users.owner)).some((k) => k.orderId === orderId)).toBe(false);
  });

  it('the invoice lines themselves refuse a load of a provisional order (direct SQL)', async () => {
    const c = await clientWithLoads(app, users.owner.id, master, scene, [[2000]], { delivered: true });
    const orderId = await idOfCode(c.orders[0]!.code);
    await makeProvisional(orderId, users.owner.id);
    const r = await createInvoice(
      app,
      users.owner,
      { deliveryIds: c.orders.flatMap((o) => o.deliveryIds) },
      { today: TODAY },
    );
    expect(r.ok).toBe(false);
  });

  it('bulk confirmation is all or nothing and only for the owner roles', async () => {
    const a = await freshOrder(users.office_sales);
    const b = await freshOrder(users.office_sales);
    const ids = [
      await idOfCode(codeOf(await a.make(a.clientId, '2026-06-15'))),
      await idOfCode(codeOf(await b.make(b.clientId, '2026-06-15'))),
    ];
    await expect(confirmPricesInBulk(app, users.office_sales, ids)).rejects.toThrow();
    expect(await confirmPricesInBulk(app, users.owner, [...ids, randomUUID()])).toMatchObject({ ok: false });
    expect(
      (
        await migrator.query(
          `select 1 from order_price_status where order_id = any($1) and confirmed_at is not null`,
          [ids],
        )
      ).rowCount,
    ).toBe(0);
    expect(await confirmPricesInBulk(app, users.owner, ids)).toEqual({ ok: true, value: { confirmed: 2 } });
  });
});

describe('credit limit and overdue (AC-PROD-18, 19)', () => {
  it('an order over the limit is held: the offices see "pending approval" and no figure; loading is refused until released', async () => {
    const s = await freshOrder(users.office_sales);
    expect(await setCreditLimit(app, users.owner, { clientId: s.clientId, limitCentimes: 50_000 })).toEqual({
      ok: true,
      value: true,
    });
    const code = codeOf(await s.make(s.clientId, '2026-06-15'));
    const orderId = await idOfCode(code);
    const states = await getOrderApprovalStates(app, users.office_sales);
    expect(states.get(code)).toBe('pending_approval');
    const card = (await listApprovals(app, users.app_admin)).find(
      (k) => k.orderId === orderId && k.kind === 'credit',
    );
    expect(card).toMatchObject({ kind: 'credit', reason: 'credit_limit', limitCentimes: 50_000 });
    // office never reads the cards, the limit, or the hold row
    await expect(listApprovals(app, users.office_sales)).rejects.toThrow();
    expect(
      (
        await withRlsContext(
          app,
          { userId: users.office_sales.id, role: 'office_sales', requestId: marker },
          (tx) =>
            tx.query(
              'select 1 from order_hold union all select 1 from client_credit_limit union all select 1 from order_price_status',
            ),
        )
      ).rowCount,
    ).toBe(0);
    // a load of a held order is refused by the database
    const loaded = (sceneOrder: string) =>
      withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
        insertDelivery(tx, users.owner.id, { ...scene, orderId: sceneOrder }, 1000),
      );
    await expect(loaded(orderId)).rejects.toThrow(/waiting for approval/);
    expect(await releaseOrderHold(app, users.app_admin, { orderId, note: 'ok by phone' })).toEqual({
      ok: true,
      value: true,
    });
    expect((await getOrderApprovalStates(app, users.office_sales)).get(code)).not.toBe('pending_approval');
    await expect(loaded(orderId)).rejects.toThrow(/recette/);
  });

  it('a client with an overdue instalment has its next order held', async () => {
    const s = await freshOrder(users.office_sales);
    codeOf(await s.make(s.clientId, '2026-06-15'));
    const second = codeOf(await s.make(s.clientId, '2026-08-10', '2026-08-01'));
    expect((await getOrderApprovalStates(app, users.office_sales)).get(second)).toBe('pending_approval');
    const card = (await listApprovals(app, users.owner)).find(
      (k) => k.orderCode === second && k.kind === 'credit',
    );
    expect(card).toMatchObject({ kind: 'credit', reason: 'overdue' });
  });

  it('office reads a client’s standing as two flags and nothing else', async () => {
    const s = await freshOrder(users.office_sales);
    codeOf(await s.make(s.clientId, '2026-06-15'));
    const standings = await getClientStandings(app, users.office_sales, { today: '2026-08-01' });
    const mine = standings.find((x) => x.clientCode === s.clientCode);
    expect(mine).toEqual({ clientCode: s.clientCode, owes: true, late: true });
    expect(Object.keys(mine!).sort()).toEqual(['clientCode', 'late', 'owes']);
    await expect(getClientStandings(app, users.partner, { today: TODAY })).rejects.toThrow();
  });
});
