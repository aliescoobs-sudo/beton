import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrder, createPurchase } from '../src/modules/ledger';
import { createPlant, type Plant, updatePlant } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { orderMaster, purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// C3: the plant picker on the order and the purchase forms. With two active plants the database refuses a row without a plant,
// so the form names it. Both plants are archived at the end so that the other files see no active plant.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const marker = 'pp' + randomUUID().replace(/-/g, '').slice(0, 8);
const letters = (n: number) =>
  Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
let owner: SessionUser, office: SessionUser, A: Plant, B: Plant, C: Plant;
let master: PurchaseMaster;
let order: Awaited<ReturnType<typeof orderMaster>>;

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
  expect((await migrator.query(`select 1 from plant where status = 'active'`)).rowCount).toBe(0);
  const a = await createPlant(app, owner, { code: letters(6), name: `A ${marker}` });
  if (!a.ok) throw new Error(a.error);
  A = a.value;
  master = await purchaseMaster(app, owner.id, marker);
  order = await orderMaster(app, owner.id, marker);
  const b = await createPlant(app, owner, { code: letters(6), name: `B ${marker}` });
  if (!b.ok) throw new Error(b.error);
  B = b.value;
});
afterAll(async () => {
  for (const p of [A, B, C]) if (p) await updatePlant(app, owner, p.id, { status: 'archived' });
  await Promise.all([app.end(), migrator.end()]);
});

const orderInput = (extra: object = {}) => ({
  clientId: order.clientId,
  concreteTypeId: order.typeId,
  dischargeMethod: 'GOULOTTE',
  volumeL: 5000,
  deliveryDate: '2026-06-10',
  plan: { preset: 'cash' },
  ...extra,
});
const purchaseInput = (extra: object = {}) => ({
  supplierId: master.supplierId,
  lines: [
    {
      componentId: master.componentId,
      purchaseUnitId: master.unitId,
      qtyMilli: 1000,
      unitPriceHtCentimes: 145_000,
    },
  ],
  ...extra,
});
const plantOf = async (table: string, code: string) =>
  (await migrator.query<{ plant_id: string }>(`select plant_id from ${table} where code = $1`, [code]))
    .rows[0]?.plant_id;

describe('plant picker (C3)', () => {
  it('an order with two active plants needs the plant; the chosen plant is the one stored', async () => {
    const without = await createOrder(app, office, orderInput(), { today: '2026-06-01' });
    expect(without.ok).toBe(false);
    for (const plant of [A, B]) {
      const made = await createOrder(app, office, orderInput({ plantId: plant.id }), { today: '2026-06-01' });
      if (!made.ok) throw new Error(made.error);
      expect(await plantOf('sales_order', made.value.code)).toBe(plant.id);
    }
    // the owner's path (with the preview and the price) takes the plant the same way
    const byOwner = await createOrder(app, owner, orderInput({ plantId: B.id }), { today: '2026-06-01' });
    if (!byOwner.ok) throw new Error(byOwner.error);
    expect(await plantOf('sales_order', byOwner.value.code)).toBe(B.id);
  });

  it('a purchase with two active plants needs the plant too', async () => {
    expect((await createPurchase(app, office, purchaseInput(), { today: '2026-06-01' })).ok).toBe(false);
    const made = await createPurchase(app, office, purchaseInput({ plantId: B.id }), { today: '2026-06-01' });
    if (!made.ok) throw new Error(made.error);
    expect(await plantOf('purchase', made.value.code)).toBe(B.id);
  });

  it('an archived or unknown plant is refused, never silently replaced', async () => {
    const c = await createPlant(app, owner, { code: letters(6), name: `C ${marker}` });
    if (!c.ok) throw new Error(c.error);
    C = c.value;
    await updatePlant(app, owner, C.id, { status: 'archived' });
    expect((await createOrder(app, office, orderInput({ plantId: C.id }), { today: '2026-06-01' })).ok).toBe(
      false,
    );
    expect(
      (await createOrder(app, office, orderInput({ plantId: randomUUID() }), { today: '2026-06-01' })).ok,
    ).toBe(false);
    expect(
      (await createPurchase(app, office, purchaseInput({ plantId: C.id }), { today: '2026-06-01' })).ok,
    ).toBe(false);
  });
});
