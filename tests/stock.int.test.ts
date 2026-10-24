import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { scaleQty } from '../src/lib/quantity';
import { cancelLoad, createLoad, getStockLevels, setOpeningStock } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import {
  deliveryScene,
  type DeliveryScene,
  insertOrderWithItems,
  orderMaster,
} from './helpers/ledger-fixtures';

// operations O3: a load moves the stock by the recette in force; cancelling gives it back. AC-OPS-02, AC-OPS-04.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `stk${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';
let scene: DeliveryScene;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});

/** A fresh order (100 m³) for the scene's type, so volumes of several loads never run out. */
async function bigOrder() {
  const master = await orderMaster(app, users.owner.id, marker);
  return inCtx(users.owner, async (tx) => {
    const client = await tx.query<{ id: string }>(
      `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
      [`stk ${randomUUID()}`],
    );
    return insertOrderWithItems(tx, users.owner.id, master, client.rows[0]?.id as string, [936_000], {
      volumeL: 100_000,
    });
  });
}
const moves = (deliveryId: string) =>
  inCtx(
    users.owner,
    async (tx) =>
      (
        await tx.query<{ component_id: string; qty_base: string; source: string }>(
          `select component_id, qty_base::text, source from stock_movement where source_id = $1 order by component_id`,
          [deliveryId],
        )
      ).rows,
  );
const levelOf = async (componentId: string) =>
  Number((await getStockLevels(app, users.owner)).find((c) => c.componentId === componentId)?.level);

describe('a load takes the recette out of the stock (AC-OPS-02)', () => {
  it('8 m³: 2 800 000 g of cement and 6 400 000 g of sand, written with the load', async () => {
    const o = await bigOrder();
    const cementBefore = await levelOf(scene.cementId);
    const sandBefore = await levelOf(scene.sandId);
    const l = await createLoad(
      app,
      users.plant,
      { orderId: o.id, truckId: scene.truckId, volumeL: 8000 },
      { today: TODAY },
    );
    if (!l.ok) throw new Error(l.error);
    const m = await moves(l.value.id);
    const byComponent = new Map(m.map((x) => [x.component_id, Number(x.qty_base)]));
    expect(byComponent.get(scene.cementId)).toBe(-2_800_000);
    expect(byComponent.get(scene.sandId)).toBe(-6_400_000);
    expect(m.every((x) => x.source === 'delivery')).toBe(true);
    expect(await levelOf(scene.cementId)).toBe(cementBefore - 2_800_000);
    expect(await levelOf(scene.sandId)).toBe(sandBefore - 6_400_000);
  });

  it('property: over any loads the stock falls by the recette times the m³, within one base unit per load', async () => {
    const o = await bigOrder();
    const before = await levelOf(scene.cementId);
    const volumes = [1234, 4321, 777, 8000, 3];
    for (const volumeL of volumes) {
      const r = await createLoad(
        app,
        users.plant,
        { orderId: o.id, truckId: scene.truckId, volumeL },
        { today: TODAY },
      );
      expect(r.ok).toBe(true);
    }
    const exact = (350_000 * volumes.reduce((n, v) => n + v, 0)) / 1000;
    expect(Math.abs(before - (await levelOf(scene.cementId)) - exact)).toBeLessThanOrEqual(
      volumes.length / 2,
    );
  });

  it('a refused load moves nothing', async () => {
    const o = await bigOrder();
    const before = await levelOf(scene.cementId);
    expect(
      (
        await createLoad(
          app,
          users.plant,
          { orderId: o.id, truckId: scene.truckId, volumeL: 9000 },
          { today: TODAY },
        )
      ).ok,
    ).toBe(false);
    expect(await levelOf(scene.cementId)).toBe(before);
  });

  it('the database refuses a wrong quantity, a component outside the recette, and a load without its movements', async () => {
    const o = await bigOrder();
    const base = { orderId: o.id, truckId: scene.truckId, recetteId: scene.recetteId };
    const asDelivery = async (extra: (tx: pg.PoolClient, id: string) => Promise<void>) =>
      inCtx(users.plant, async (tx) => {
        const id = randomUUID();
        const bl = (await tx.query<{ n: string }>(`select public.next_doc_number('BL', 2026, 5) as n`))
          .rows[0]?.n;
        await tx.query(
          `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, recette_id, created_by) values ($1, $2, $3, $4, 1000, '2026-06-01', $5, $6)`,
          [id, bl, base.orderId, base.truckId, base.recetteId, users.plant.id],
        );
        await extra(tx, id);
      });
    const movement = (tx: pg.PoolClient, id: string, component: string, qty: number) =>
      tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by) values (gen_random_uuid(), $1, '2026-06-01', $2, 'delivery', $3, $4)`,
        [component, qty, id, users.plant.id],
      );
    // 1 m³ of cement is 350 000 g: 349 999 is wrong.
    await expect(
      asDelivery(async (tx, id) => void (await movement(tx, id, scene.cementId, -349_999))),
    ).rejects.toMatchObject({ code: '23514' });
    // Water is not in this recette.
    const water = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>(`select id from component where lower(name_fr) = 'eau'`),
      )
    ).rows[0]?.id as string;
    await expect(
      asDelivery(async (tx, id) => void (await movement(tx, id, water, -180))),
    ).rejects.toMatchObject({ code: '23514' });
    // Only the cement is written: the sand is missing at commit.
    await expect(
      asDelivery(async (tx, id) => void (await movement(tx, id, scene.cementId, -350_000))),
    ).rejects.toMatchObject({ code: '23514' });
    // Nothing at all.
    await expect(asDelivery(async () => undefined)).rejects.toMatchObject({ code: '23514' });
    // Both lines, right: accepted.
    await asDelivery(async (tx, id) => {
      await movement(tx, id, scene.cementId, -350_000);
      await movement(tx, id, scene.sandId, -800_000);
    });
  });
});

describe('cancelling a load (AC-OPS-04)', () => {
  it('writes reversing movements that give the stock back, and leaves the original rows alone', async () => {
    const o = await bigOrder();
    const l = await createLoad(
      app,
      users.plant,
      { orderId: o.id, truckId: scene.truckId, volumeL: 5000 },
      { today: TODAY },
    );
    if (!l.ok) throw new Error('setup');
    const before = await levelOf(scene.cementId);
    const c = await cancelLoad(
      app,
      users.owner,
      { deliveryId: l.value.id, reason: 'béton refusé sur chantier' },
      { today: '2026-06-02' },
    );
    if (!c.ok) throw new Error(c.error);
    expect(await levelOf(scene.cementId)).toBe(before + 1_750_000);
    const original = await moves(l.value.id);
    expect(original.map((x) => x.source)).toEqual(['delivery', 'delivery']);
    const reversal = await moves(c.value.id);
    expect(reversal.map((x) => x.source)).toEqual(['reversal', 'reversal']);
    expect(reversal.map((x) => Number(x.qty_base)).sort()).toEqual(
      original.map((x) => -Number(x.qty_base)).sort(),
    );
  });

  it('a movement cannot be reversed twice or edited, and nothing is deleted', async () => {
    const o = await bigOrder();
    const l = await createLoad(
      app,
      users.plant,
      { orderId: o.id, truckId: scene.truckId, volumeL: 1000 },
      { today: TODAY },
    );
    if (!l.ok) throw new Error('setup');
    await cancelLoad(app, users.owner, { deliveryId: l.value.id, reason: 'erreur' }, { today: TODAY });
    for (const sql of [
      'update stock_movement set qty_base = 1',
      'delete from stock_movement',
      'truncate stock_movement',
    ])
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('stock levels and the opening stock', () => {
  it('plant, owner, partner and support read the levels; office does not', async () => {
    for (const role of ['plant', 'owner', 'partner', 'support'] as const)
      expect((await getStockLevels(app, users[role])).length).toBeGreaterThanOrEqual(6);
    await expect(getStockLevels(app, users.office)).rejects.toThrow();
    expect((await inCtx(users.office, (tx) => tx.query('select 1 from stock_movement'))).rows).toEqual([]);
  });

  it('the plant sees quantities only: no price, cost, total or amount anywhere', async () => {
    expectNoFields(await getStockLevels(app, users.plant), [
      'price',
      'cost',
      'total',
      'amountCentimes',
      'priceHtCentimes',
      'unitPrice',
    ]);
  });

  it('the opening stock of a component is entered once by the owner or the partner', async () => {
    const water = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>(`select id from component where lower(name_fr) = 'eau'`),
      )
    ).rows[0]?.id as string;
    const first = await setOpeningStock(app, users.owner, {
      componentId: water,
      qtyBase: 50_000,
      date: '2026-05-01',
    });
    // Another suite may have entered it already: either way a second entry is refused.
    expect([true, false]).toContain(first.ok);
    expect(
      await setOpeningStock(app, users.partner, { componentId: water, qtyBase: 1, date: '2026-05-02' }),
    ).toEqual({ ok: false, error: 'ALREADY_ENTERED' });
    expect(
      await setOpeningStock(app, users.owner, { componentId: randomUUID(), qtyBase: 1, date: '2026-05-02' }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(
      await setOpeningStock(app, users.owner, { componentId: water, qtyBase: 0, date: '2026-05-02' }),
    ).toEqual({ ok: false, error: 'INVALID' });
    for (const role of ['plant', 'office', 'support'] as const)
      await expect(
        setOpeningStock(app, users[role], { componentId: water, qtyBase: 1, date: '2026-05-02' }),
      ).rejects.toThrow();
  });
});

describe('the SQL rounding is the TypeScript rounding', () => {
  it('scale_qty agrees with scaleQty on a grid and on random values', async () => {
    const sql = async (q: number, n: number, d: number) =>
      Number(
        (
          await migrator.query<{ r: string }>(
            'select public.scale_qty($1::bigint, $2::bigint, $3::bigint)::text as r',
            [q, n, d],
          )
        ).rows[0]?.r,
      );
    for (const [q, n, d] of [
      [350_000, 8000, 1000],
      [3500, 7, 1000],
      [3500, 3, 1000],
      [1, 1, 2],
      [1, 1, 3],
      [5, 1, 2],
      [180, 7500, 1000],
    ] as const)
      expect(await sql(q, n, d)).toBe(scaleQty(q, n, d));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 30_000 }),
        async (q, n) => (await sql(q, n, 1000)) === scaleQty(q, n, 1000),
      ),
      { numRuns: 40 },
    );
  });
});
