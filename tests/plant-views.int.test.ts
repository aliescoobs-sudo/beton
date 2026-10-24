import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoad, listDeliveries, listLoadableOrders } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O4: what the plant screens read. AC-OPS-09: no price, total, client phone or payment, at service level.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `pv${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2099-01-01';
const MONEY = [
  'priceCentimes',
  'unitPriceHtCentimes',
  'unit_price_ht_centimes',
  'totalTtcCentimes',
  'total_ttc_centimes',
  'total_ht_centimes',
  'amountCentimes',
  'phone',
  'clientName',
  'name',
  'planItems',
];
let scene: DeliveryScene;

beforeAll(async () => {
  for (const role of ['owner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});

describe('plant views (O4)', () => {
  it('lists the order with what is left, loads it, and the remaining volume falls', async () => {
    const before = (await listLoadableOrders(app, users.plant, TODAY)).find((o) => o.id === scene.orderId);
    expect(before).toBeDefined();
    expect(before?.remainingL).toBe(before?.volumeL);
    const l = await createLoad(
      app,
      users.plant,
      { orderId: scene.orderId, truckId: scene.truckId, volumeL: 1000 },
      { today: TODAY },
    );
    if (!l.ok) throw new Error(l.error);
    const after = (await listLoadableOrders(app, users.plant, TODAY)).find((o) => o.id === scene.orderId);
    expect(after?.remainingL).toBe((before?.volumeL ?? 0) - 1000);
    const delivery = (await listDeliveries(app, users.plant)).find((d) => d.id === l.value.id);
    expect(delivery).toMatchObject({ blNo: l.value.blNo, volumeL: 1000, cancelled: false, returnedOn: null });
  });

  it('an order due in the future is not offered for loading', async () => {
    const list = await listLoadableOrders(app, users.plant, '1999-01-01');
    expect(list.find((o) => o.id === scene.orderId)).toBeUndefined();
  });

  it('shows the plant no price, total, client name or phone, payment or plan (AC-OPS-09)', async () => {
    for (const role of ['plant', 'office', 'support'] as const) {
      expectNoFields(await listLoadableOrders(app, users[role], TODAY), MONEY);
      expectNoFields(await listDeliveries(app, users[role]), MONEY);
    }
  });
});
