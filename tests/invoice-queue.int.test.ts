import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createInvoice, getInvoiceQueue } from '../src/modules/ledger';
import { cancelLoad, markDelivered, recordLoss } from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene, newDelivery } from './helpers/ledger-fixtures';

// integration I1.3: the delivered-not-invoiced queue per client. AC-INT-05.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `iq${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-06-10';
let scene: DeliveryScene;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const deliver = async (litres: number) => {
  const d = await newDelivery(app, users.owner.id, marker, scene, litres);
  expect(
    (await markDelivered(app, users.plant, { deliveryId: d.id }, { now: new Date('2026-06-02T10:00:00Z') }))
      .ok,
  ).toBe(true);
  return d;
};
const mine = async (actor: SessionUser) =>
  (await getInvoiceQueue(app, actor)).find((c) => c.clientId === scene.clientId);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});

describe('what is in the queue (AC-INT-05)', () => {
  let a = { id: '', blNo: '' };
  let b = { id: '', blNo: '' };
  let onTheRoad = { id: '', blNo: '' };

  it('holds exactly the delivered loads no live invoice carries', async () => {
    onTheRoad = await newDelivery(app, users.owner.id, marker, scene, 300);
    a = await deliver(1000);
    b = await deliver(500);
    const q = await mine(users.owner);
    expect(q?.deliveries.map((d) => d.blNo).sort()).toEqual([a.blNo, b.blNo].sort());
    expect(q?.deliveries.map((d) => d.blNo)).not.toContain(onTheRoad.blNo);
    expect(q?.totalVolumeL).toBe(1500);
  });

  it('a cancelled load and a wholly refused load leave the queue; a partial loss stays', async () => {
    const cancelled = await deliver(200);
    const refused = await deliver(300);
    const partial = await deliver(400);
    expect((await mine(users.owner))?.totalVolumeL).toBe(1500 + 200 + 300 + 400);
    expect(
      (await cancelLoad(app, users.owner, { deliveryId: cancelled.id, reason: 'erreur' }, { today: TODAY }))
        .ok,
    ).toBe(true);
    expect(
      (
        await recordLoss(app, users.office, {
          deliveryId: refused.id,
          volumeL: 300,
          reason: 'rejected_by_client',
        })
      ).ok,
    ).toBe(true);
    expect(
      (await recordLoss(app, users.plant, { deliveryId: partial.id, volumeL: 100, reason: 'quality' })).ok,
    ).toBe(true);
    expect((await mine(users.owner))?.totalVolumeL).toBe(1500 + 400);
    // tidy: the partial one is invoiced below with the others
  });

  it('the owner and support see what each load comes to at its order price, and what the client is owed', async () => {
    for (const role of ['owner', 'support'] as const) {
      const q = await mine(users[role]);
      const byBl = new Map(q?.deliveries.map((d) => [d.blNo, d.amountHtCentimes]));
      // unit price 780,00 per m³: 1 m³ = 78 000 centimes, 0,5 m³ = 39 000
      expect(byBl.get(a.blNo), role).toBe(78_000);
      expect(byBl.get(b.blNo), role).toBe(39_000);
      expect(q?.money, role).toEqual({
        htCentimes: 78_000 + 39_000 + 31_200,
        vatCentimes: 29_640,
        ttcCentimes: 78_000 + 39_000 + 31_200 + 29_640,
      });
    }
  });

  it('office sees the loads, dates, products and m³, and the answer has no money key at all', async () => {
    const q = await mine(users.office);
    expect(q?.deliveries).toHaveLength(3);
    expect(q?.deliveries[0]).toMatchObject({ typeCode: expect.any(String), volumeL: expect.any(Number) });
    const all = await getInvoiceQueue(app, users.office);
    expectNoFields(all, [
      'money',
      'amountHtCentimes',
      'amountCentimes',
      'unitPrice',
      'price',
      'total',
      'totalTtcCentimes',
      'orderCode',
    ]);
    expect(JSON.stringify(all)).not.toMatch(/78000|39000|9360|\bMAD\b/);
  });

  it('partner and plant have no access, in the service and in the database', async () => {
    await expect(getInvoiceQueue(app, users.partner)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getInvoiceQueue(app, users.plant)).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ['partner', 'plant'] as const) {
      await expect(
        inCtx(users[role], (tx) => tx.query('select * from public.invoice_queue()')),
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('invoicing a load takes it out of the queue; cancelling the invoice puts it back', async () => {
    const made = await createInvoice(
      app,
      users.owner,
      { orderCode: await orderCode(), deliveryIds: [a.id] },
      { today: TODAY },
    );
    expect(made.ok).toBe(true);
    const q = await mine(users.owner);
    expect(q?.deliveries.map((d) => d.blNo)).not.toContain(a.blNo);
    expect(q?.deliveries.map((d) => d.blNo)).toContain(b.blNo);
  });
});

async function orderCode(): Promise<string> {
  const r = await inCtx(users.owner, (tx) =>
    tx.query<{ code: string }>(`select code from sales_order where id = $1`, [scene.orderId]),
  );
  return r.rows[0]?.code as string;
}
