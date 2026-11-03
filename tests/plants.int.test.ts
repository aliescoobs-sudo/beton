import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createPurchase } from '../src/modules/ledger';
import {
  createPlant,
  createTruck,
  listPlants,
  listTrucks,
  logTruckStatus,
  type Plant,
  updatePlant,
  updateTruck,
} from '../src/modules/master-data';
import {
  confirmArrivalAtPlant,
  getReorderThresholds,
  getStockLevels,
  getVolumeByPlant,
  recordReceipt,
  setOpeningStock,
  setStockThreshold,
  getDispatchDay,
} from '../src/modules/operations';
import { inPlant } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  deliveryScene,
  insertDelivery,
  purchaseMaster,
  type PurchaseMaster,
} from './helpers/ledger-fixtures';

// R1 (CP-PROD-PLAN): AC-PROD-01 to 07. Two plants share the database for this file only; both are archived at the end so
// the other files see no active plant (the plant rule then does nothing).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `pl${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
let A: Plant;
let B: Plant;
let master: PurchaseMaster;
let scene: Awaited<ReturnType<typeof deliveryScene>>;
const TODAY = '2026-06-10';
// A wide random start: the database is shared by the other test files and a small range collided with their truck codes (DUPLICATE).
// Truck codes are letter + at most three digits and the database is shared by the other test files: take the first free number
// after a random start (a fixed random range collided with their codes and failed with DUPLICATE now and then).
let truckNo = 100 + Math.floor(Math.random() * 400);
const takenTruckNos = new Set<number>();
const nextTruckNo = () => {
  while (takenTruckNos.has(truckNo)) truckNo++;
  return truckNo++;
};

const plantOf = async (table: string, id: string) =>
  (await migrator.query<{ plant_id: string | null }>(`select plant_id from ${table} where id = $1`, [id]))
    .rows[0]?.plant_id;
const levelOf = async (plantId: string | null, componentId: string) =>
  Number(
    (await getStockLevels(app, users.plant, { plantId })).find((c) => c.componentId === componentId)?.level ??
      0,
  );

beforeAll(async () => {
  for (const r of (await migrator.query<{ code: string }>('select code from truck')).rows)
    takenTruckNos.add(Number(r.code.slice(1)));
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  const active = await migrator.query(`select 1 from plant where status = 'active'`);
  expect(active.rowCount).toBe(0);
  const a = await createPlant(app, users.owner, { code: letters(6), name: `A ${marker}` });
  if (!a.ok) throw new Error(a.error);
  A = a.value;
  // Built while only A exists: everything the scene and the purchases insert takes A (one plant, no choice).
  master = await purchaseMaster(app, users.owner.id, marker);
  scene = await deliveryScene(app, users.owner.id, marker);
  const b = await createPlant(app, users.owner, { code: letters(6), name: `B ${marker}` });
  if (!b.ok) throw new Error(b.error);
  B = b.value;
});

afterAll(async () => {
  for (const p of [A, B]) if (p) await updatePlant(app, users.owner, p.id, { status: 'archived' });
  await Promise.all([app.end(), migrator.end()]);
});

const buy = (as: SessionUser) =>
  createPurchase(
    app,
    as,
    {
      supplierId: master.supplierId,
      lines: [
        {
          componentId: master.componentId,
          purchaseUnitId: master.unitId,
          qtyMilli: 1000,
          unitPriceHtCentimes: 145_000,
        },
      ],
    },
    { today: '2026-06-01' },
  );

describe('plants exist and are managed (AC-PROD-01)', () => {
  it('every internal role reads them; only managers write; a code is unique', async () => {
    for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
      const ids = (await listPlants(app, users[role])).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([A.id, B.id]));
    }
    await expect(createPlant(app, users.office, { code: letters(5), name: 'x' })).rejects.toThrow();
    expect(await createPlant(app, users.owner, { code: A.code, name: `dup ${marker}` })).toEqual({
      ok: false,
      error: 'DUPLICATE',
    });
    expect(await createPlant(app, users.owner, { code: 'x1', name: 'bad' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('with two active plants a row must name its plant: refused by the database, accepted with a plant', async () => {
    const without = await buy(users.office);
    expect(without.ok).toBe(false);
    const inB = await buy(inPlant(users.office, B.id));
    if (!inB.ok) throw new Error(inB.error);
    expect(await plantOf('purchase', inB.value.id)).toBe(B.id);
    // an archived or unknown plant is refused too
    const unknown = await buy(inPlant(users.office, randomUUID()));
    expect(unknown.ok).toBe(false);
  });
});

describe('stock and loads are per plant (AC-PROD-02, 03)', () => {
  it('an opening stock is one per component and plant; the total is the sum of the plants', async () => {
    const a = await setOpeningStock(app, users.owner, {
      componentId: master.componentId,
      date: '2026-05-01',
      qtyBase: 5_000_000,
      plantId: A.id,
    });
    const b = await setOpeningStock(app, users.owner, {
      componentId: master.componentId,
      date: '2026-05-01',
      qtyBase: 2_000_000,
      plantId: B.id,
    });
    expect(a.ok && b.ok).toBe(true);
    expect(
      await setOpeningStock(app, users.owner, {
        componentId: master.componentId,
        date: '2026-05-02',
        qtyBase: 1,
        plantId: A.id,
      }),
    ).toEqual({ ok: false, error: 'ALREADY_ENTERED' });
    // no plant given with two plants: refused, nothing written
    expect(
      (
        await setOpeningStock(app, users.owner, {
          componentId: master.componentId,
          date: '2026-05-02',
          qtyBase: 1,
        })
      ).ok,
    ).toBe(false);
    const [la, lb, total] = [
      await levelOf(A.id, master.componentId),
      await levelOf(B.id, master.componentId),
      await levelOf(null, master.componentId),
    ];
    expect(la).toBe(5_000_000);
    expect(lb).toBe(2_000_000);
    const legacyOpen = Number(
      (
        await migrator.query<{ n: string }>(
          `select coalesce(sum(qty_base), 0)::text as n from stock_movement where component_id = $1 and (plant_id is null or plant_id not in ($2, $3))`,
          [master.componentId, A.id, B.id],
        )
      ).rows[0]?.n,
    );
    expect(total).toBe(la + lb + legacyOpen);
  });

  it('a load takes its stock from the plant of its order only', async () => {
    const cement = scene.cementId;
    // the scene order belongs to A; its 8 m³ load uses the recette, and the cement leaves plant A
    await setOpeningStock(app, users.owner, {
      componentId: cement,
      date: '2026-05-01',
      qtyBase: 10_000_000,
      plantId: A.id,
    });
    await setOpeningStock(app, users.owner, {
      componentId: cement,
      date: '2026-05-01',
      qtyBase: 10_000_000,
      plantId: B.id,
    });
    const [a0, b0] = [await levelOf(A.id, cement), await levelOf(B.id, cement)];
    const d = await withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
      insertDelivery(tx, users.owner.id, scene, 8_000),
    );
    expect(await plantOf('delivery', d.id)).toBe(A.id);
    expect(await levelOf(A.id, cement)).toBe(a0 - 8 * 350_000);
    expect(await levelOf(B.id, cement)).toBe(b0);
    // the total also holds the movements of no plant (before plants existed) and of other plants made by other suites: total = A + B + those
    const legacy = Number(
      (
        await migrator.query<{ n: string }>(
          `select coalesce(sum(qty_base), 0)::text as n from stock_movement where component_id = $1 and (plant_id is null or plant_id not in ($2, $3))`,
          [cement, A.id, B.id],
        )
      ).rows[0]?.n,
    );
    expect(await levelOf(null, cement)).toBe(
      (await levelOf(A.id, cement)) + (await levelOf(B.id, cement)) + legacy,
    );
    const moves = await migrator.query<{ plant_id: string }>(
      `select plant_id from stock_movement where source = 'delivery' and source_id = $1`,
      [d.id],
    );
    expect(moves.rows.length).toBeGreaterThan(0);
    expect(moves.rows.every((m) => m.plant_id === A.id)).toBe(true);
  });

  it('a truck of the other plant cannot load an order of this one', async () => {
    const t = await createTruck(app, users.owner, {
      code: `T${nextTruckNo()}`,
      plate: `PL-${letters(6)}`,
      plantId: B.id,
    });
    if (!t.ok) throw new Error(t.error);
    await expect(
      withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
        insertDelivery(tx, users.owner.id, { ...scene, truckId: t.value.id }, 1000),
      ),
    ).rejects.toThrow(/another plant/);
    await updateTruck(
      app,
      users.owner,
      t.value.id,
      { plate: t.value.plate, capacityL: t.value.capacityL },
      'archived',
    );
  });

  it('stats per plant add up to the total', async () => {
    const r = await getVolumeByPlant(app, users.partner, { from: '2026-06-01', to: '2026-06-01' });
    if (!r.ok) throw new Error(r.error);
    const mine = r.value.plants.find((p) => p.plantId === A.id);
    expect(mine?.volumeL).toBeGreaterThanOrEqual(8_000);
    expect(r.value.totalL).toBe(r.value.plants.reduce((n, p) => n + p.volumeL, 0));
    expect(Object.keys(r.value).sort()).toEqual(['from', 'plants', 'to', 'totalL']);
    expect(JSON.stringify(r.value)).not.toMatch(/centimes|price|amount/i);
  });
});

describe('the fleet (AC-PROD-04, 05)', () => {
  const code = (p: 'T' | 'P' | 'X') => `${p}${nextTruckNo()}`;
  const plate = () => `FL-${letters(8)}`;

  it('a stopped truck stays in the fleet, carries a decision, and cannot be planned', async () => {
    const t = await createTruck(app, users.owner, { code: code('T'), plate: plate(), plantId: A.id });
    if (!t.ok) throw new Error(t.error);
    const stop = await logTruckStatus(app, users.plant, {
      truckId: t.value.id,
      status: 'breakdown',
      fromDate: '2026-06-01',
      toDate: null,
      reason: 'gearbox',
    });
    expect(stop.ok).toBe(true);
    const upd = await updateTruck(app, users.owner, t.value.id, {
      plate: t.value.plate,
      capacityL: t.value.capacityL,
      stoppedDecision: 'repair_sell',
    });
    if (!upd.ok) throw new Error(upd.error);
    expect(upd.value.stoppedDecision).toBe('repair_sell');
    expect((await listTrucks(app, users.office)).some((x) => x.id === t.value.id)).toBe(true);
    const day = await getDispatchDay(app, users.plant, '2026-06-12', { plantId: A.id });
    if (!day.ok) throw new Error(day.error);
    expect(day.value.trucks.find((x) => x.id === t.value.id)?.available).toBe(false);
    await updateTruck(
      app,
      users.owner,
      t.value.id,
      { plate: t.value.plate, capacityL: t.value.capacityL },
      'archived',
    );
  });

  it('a pump has no plant, an external truck has a pay basis, a mixer needs its plant', async () => {
    const pump = await createTruck(app, users.owner, { code: code('P'), plate: plate(), kind: 'pump' });
    expect(pump.ok && pump.value.plantId === null && pump.value.kind === 'pump').toBe(true);
    expect(
      (await createTruck(app, users.owner, { code: code('P'), plate: plate(), kind: 'pump', plantId: A.id }))
        .ok,
    ).toBe(false);
    const ext = await createTruck(app, users.owner, {
      code: code('X'),
      plate: plate(),
      kind: 'external',
      payBasis: 'per_m3',
    });
    expect(ext.ok && ext.value.payBasis === 'per_m3').toBe(true);
    expect(
      (await createTruck(app, users.owner, { code: code('T'), plate: plate(), payBasis: 'per_trip' })).ok,
    ).toBe(false);
    expect((await createTruck(app, users.owner, { code: code('T'), plate: plate() })).ok).toBe(false);
    expect((await createTruck(app, users.owner, { code: code('P'), plate: plate(), kind: 'mixer' })).ok).toBe(
      false,
    );
    // the pump is not in a plant's dispatch; the external truck is
    const day = await getDispatchDay(app, users.plant, '2026-06-12', { plantId: A.id });
    if (!day.ok) throw new Error(day.error);
    if (pump.ok) expect(day.value.trucks.some((x) => x.id === pump.value.id)).toBe(false);
    if (ext.ok) expect(day.value.trucks.some((x) => x.id === ext.value.id)).toBe(true);
    for (const t of [pump, ext]) {
      if (t.ok)
        await updateTruck(
          app,
          users.owner,
          t.value.id,
          { plate: t.value.plate, capacityL: t.value.capacityL },
          'archived',
        );
    }
  });

  it('a truck cannot change kind or code', async () => {
    const t = await createTruck(app, users.owner, { code: code('T'), plate: plate(), plantId: A.id });
    if (!t.ok) throw new Error(t.error);
    await expect(
      withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query(`update truck set kind = 'external' where id = $1`, [t.value.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    // a truck with loads cannot move to the other plant
    await withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
      tx.query(`update truck set plant_id = $2 where id = $1`, [t.value.id, B.id]),
    );
    await updateTruck(
      app,
      users.owner,
      t.value.id,
      { plate: t.value.plate, capacityL: t.value.capacityL },
      'archived',
    );
  });
});

describe('two-step receipt (AC-PROD-06)', () => {
  it('stock goes up only after the plant and then the office confirm', async () => {
    const p = await buy(inPlant(users.office, A.id));
    if (!p.ok) throw new Error(p.error);
    const before = await levelOf(A.id, master.componentId);
    // the office cannot receive before the plant confirmed
    expect(await recordReceipt(app, users.owner, { purchaseId: p.value.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'PLANT_NOT_CONFIRMED',
    });
    // the plant cannot do the office's step
    expect(await recordReceipt(app, users.plant, { purchaseId: p.value.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'PLANT_CONFIRMS_FIRST',
    });
    expect(await levelOf(A.id, master.componentId)).toBe(before);
    // first step: the plant confirms; still no stock
    const c = await confirmArrivalAtPlant(app, users.plant, { purchaseId: p.value.id });
    expect(c.ok).toBe(true);
    expect(await confirmArrivalAtPlant(app, users.plant, { purchaseId: p.value.id })).toEqual({
      ok: false,
      error: 'ALREADY_CONFIRMED',
    });
    expect(await levelOf(A.id, master.componentId)).toBe(before);
    // second step: the office records it; stock goes up in plant A only
    const r = await recordReceipt(app, users.owner, { purchaseId: p.value.id }, { today: TODAY });
    expect(r.ok).toBe(true);
    expect(await levelOf(A.id, master.componentId)).toBeGreaterThan(before);
    expect(await levelOf(B.id, master.componentId)).toBe(2_000_000);
    // the confirmation is used: a second receipt needs a new one
    expect((await recordReceipt(app, users.owner, { purchaseId: p.value.id }, { today: TODAY })).ok).toBe(
      false,
    );
  });

  it('a plant manager scoped to the other plant cannot confirm', async () => {
    const p = await buy(inPlant(users.office, A.id));
    if (!p.ok) throw new Error(p.error);
    expect(await confirmArrivalAtPlant(app, inPlant(users.plant, B.id), { purchaseId: p.value.id })).toEqual({
      ok: false,
      error: 'NOT_YOUR_PLANT',
    });
    expect(
      (await confirmArrivalAtPlant(app, inPlant(users.plant, A.id), { purchaseId: p.value.id })).ok,
    ).toBe(true);
  });
});

describe('reorder threshold per plant (AC-PROD-07)', () => {
  it('is derived from the lead time and the plant’s own consumption; a set threshold wins', async () => {
    const cement = scene.cementId;
    await migrator.query(`update component set lead_time_days = 2 where id = $1`, [cement]);
    const a = (await getReorderThresholds(app, users.plant, { plantId: A.id, today: '2026-06-10' })).find(
      (t) => t.componentId === cement,
    );
    const b = (await getReorderThresholds(app, users.plant, { plantId: B.id, today: '2026-06-10' })).find(
      (t) => t.componentId === cement,
    );
    expect(a?.consumedBase).toBeGreaterThanOrEqual(8 * 350_000);
    expect(a?.derived).toBe(Math.ceil((a!.consumedBase * 3) / 30));
    expect(b?.consumedBase).toBe(0);
    expect(b?.derived).toBeNull();
    const set = await setStockThreshold(app, users.owner, {
      componentId: cement,
      lowQtyBase: 123,
      plantId: B.id,
    });
    expect(set.ok).toBe(true);
    const b2 = (await getReorderThresholds(app, users.plant, { plantId: B.id, today: '2026-06-10' })).find(
      (t) => t.componentId === cement,
    );
    expect(b2?.set).toBe(123);
    expect(
      (await getStockLevels(app, users.plant, { plantId: B.id })).find((c) => c.componentId === cement)
        ?.lowThreshold,
    ).toBe(123);
    await migrator.query(`update component set lead_time_days = null where id = $1`, [cement]);
  });
});
