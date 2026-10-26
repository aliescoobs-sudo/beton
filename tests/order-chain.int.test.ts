import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { allocate, cancelOrder, createInvoice, getOrderChain } from '../src/modules/ledger';
import { saveDispatch } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  insertInstrument,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// integration I3.1: the order chain, one row per order with its six stages. AC-INT-16.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `oc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-07-03';
let scene: DeliveryScene;
let master: OrderMaster;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
});

/** An order of 10 m³: 4 m³ planned, 6 m³ loaded and delivered, 4 m³ invoiced, 1 000,00 paid. */
async function walked() {
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[4000, 2000]]);
  const order = c.orders[0]!;
  const planned = await saveDispatch(app, users.plant, {
    date: '2026-06-02',
    rotations: [{ orderId: order.id, truckId: scene.truckId, driverId: null, volumeL: 4000 }],
  });
  if (!planned.ok) throw new Error(planned.error);
  const invoice = await createInvoice(
    app,
    users.owner,
    { deliveryIds: [order.deliveryIds[0]] },
    { today: TODAY },
  );
  if (!invoice.ok) throw new Error(invoice.error);
  const cheque = await inCtx(users.owner, (tx) =>
    insertInstrument(tx, users.owner.id, { clientId: c.clientId, amountCentimes: 100_000 }),
  );
  const paid = await allocate(app, users.owner, {
    instrumentId: cheque.id,
    itemId: order.itemIds[0],
    amountCentimes: 100_000,
  });
  if (!paid.ok) throw new Error(paid.error);
  return { ...c, order };
}
const rowOf = async (actor: SessionUser, code: string) =>
  (await getOrderChain(app, actor)).find((r) => r.code === code);

describe('the six stages of an order (AC-INT-16)', () => {
  it('ordered, planned, loaded, delivered, invoiced in litres and paid as a state, for the owner', async () => {
    const w = await walked();
    expect(await rowOf(users.owner, w.order.code)).toMatchObject({
      orderedL: 10_000,
      plannedL: 4_000,
      loadedL: 6_000,
      deliveredL: 6_000,
      invoicedL: 4_000,
      paidState: 'partial',
      cancelled: false,
    });
  });

  it('a loaded load that is not delivered counts as loaded and not as delivered; a cancelled load as neither', async () => {
    const c = await clientWithLoads(app, users.owner.id, master, scene, [[3000]], { delivered: false });
    expect(await rowOf(users.owner, c.orders[0]!.code)).toMatchObject({
      loadedL: 3_000,
      deliveredL: 0,
      invoicedL: 0,
      plannedL: 0,
      paidState: 'unpaid',
    });
  });

  it('an order cancelled by its reversal is flagged and has no payment stage', async () => {
    const c = await clientWithLoads(app, users.owner.id, master, scene, [[]]);
    const order = c.orders[0]!;
    const done = await cancelOrder(
      app,
      users.owner,
      order.id,
      'commande annulée par le client',
      {},
      { today: TODAY },
    );
    expect(done.ok).toBe(true);
    expect(await rowOf(users.owner, order.code)).toMatchObject({
      cancelled: true,
      paidState: null,
      loadedL: 0,
    });
  });
});

describe('who sees what (AC-INT-16)', () => {
  it('office, plant and partner read quantities and stages, never an amount, and the paid stage is masked', async () => {
    const w = await walked();
    for (const role of ['office', 'plant', 'partner'] as const) {
      const row = await rowOf(users[role], w.order.code);
      expect(row, role).toMatchObject({
        orderedL: 10_000,
        plannedL: 4_000,
        loadedL: 6_000,
        deliveredL: 6_000,
        invoicedL: 4_000,
        paidState: null,
      });
      expectNoFields(row, [
        'amountCentimes',
        'totalTtcCentimes',
        'unitPrice',
        'price',
        'coveredCentimes',
        'total',
      ]);
      expect(JSON.stringify(row)).not.toMatch(/936000|780000|78000|100000/);
    }
  });

  it('support sees the payment stage like the owner; the function refuses a role it does not know', async () => {
    const w = await walked();
    expect((await rowOf(users.support, w.order.code))?.paidState).toBe('partial');
    await expect(
      withRlsContext(
        app,
        { userId: '00000000-0000-7000-8000-000000000000', role: 'anonymous', requestId: marker },
        (tx) => tx.query('select * from public.order_chain()'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('every role of the company may ask', async () => {
    for (const role of ['owner', 'support', 'partner', 'plant', 'office'] as const)
      await expect(getOrderChain(app, users[role])).resolves.toBeDefined();
  });
});
