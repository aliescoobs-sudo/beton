import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createLoad,
  getFuelReport,
  listFuelFills,
  recordFuelFill,
  recordFuelPurchase,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O13: fuel per truck. AC-OPS-22. A far, random period keeps other suites' fills of the same truck out of it.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `fu${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const year = 2040 + Math.floor(Math.random() * 29);
const month = String(1 + Math.floor(Math.random() * 11)).padStart(2, '0');
const D1 = `${year}-${month}-05`;
const D2 = `${year}-${month}-12`;
const D3 = `${year}-${month}-19`;
let scene: DeliveryScene;
let truck2: string;

const MONEY_FIELDS = [
  'money',
  'costCentimes',
  'costPerM3Centimes',
  'centimesPerLitre',
  'totalCentimes',
  'price',
  'costs',
];
const report = async (actor: SessionUser) => {
  const r = await getFuelReport(app, actor, { from: D1, to: D3 });
  if (!r.ok) throw new Error('report');
  return r.value;
};

/** A truck of its own (code T + 3 digits, retried on a clash with another suite's) so the pilot's T1 never mixes in. */
async function newTruck(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = `T${100 + Math.floor(Math.random() * 899)}`;
    try {
      return await withRlsContext(
        app,
        { userId: users.owner.id, role: 'owner', requestId: marker },
        async (tx) => {
          const t = await tx.query<{ id: string }>(
            `insert into truck (id, code, plate, capacity_l) values (gen_random_uuid(), $1, $2, 8000) returning id`,
            [code, `${code}-${marker.slice(0, 8)}-${i}`],
          );
          return t.rows[0]?.id as string;
        },
      );
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  throw new Error('no free truck code');
}

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  // a second truck of its own so the figures of the pilot's T1 never mix with ours
  truck2 = await newTruck();
});

describe('who records what (AC-OPS-22)', () => {
  it('plant, owner and partner record a fill; office and support are refused', async () => {
    for (const role of ['plant', 'partner', 'owner'] as const) {
      const r = await recordFuelFill(app, users[role], { truckId: truck2, filledOn: D1, litres: '10' });
      expect(r.ok, role).toBe(true);
    }
    for (const role of ['office', 'support'] as const) {
      await expect(
        recordFuelFill(app, users[role], { truckId: truck2, filledOn: D1, litres: '10' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('only the owner records a purchase of fuel (money)', async () => {
    for (const role of ['plant', 'partner', 'office', 'support'] as const) {
      await expect(
        recordFuelPurchase(app, users[role], { purchasedOn: D1, litres: '1000', totalMad: '12000' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(
      (await recordFuelPurchase(app, users.owner, { purchasedOn: D1, litres: '1000', totalMad: '12000' })).ok,
    ).toBe(true);
  });

  it('refuses nonsense: no litres, too many decimals, an unknown truck, a bad date, a negative total', async () => {
    for (const input of [
      { truckId: truck2, filledOn: D1, litres: '0' },
      { truckId: truck2, filledOn: D1, litres: '1,2345' },
      { truckId: truck2, filledOn: '2026-02-30', litres: '10' },
      { truckId: 'x', filledOn: D1, litres: '10' },
    ]) {
      expect(await recordFuelFill(app, users.plant, input)).toEqual({ ok: false, error: 'INVALID' });
    }
    expect(
      await recordFuelFill(app, users.plant, { truckId: randomUUID(), filledOn: D1, litres: '10' }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(
      await recordFuelPurchase(app, users.owner, { purchasedOn: D1, litres: '100', totalMad: '0' }),
    ).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('the odometer never goes back: a lower reading is refused by the service and the database', async () => {
    const a = await recordFuelFill(app, users.plant, {
      truckId: scene.truckId,
      filledOn: D1,
      litres: '100',
      odometerKm: 200_000,
    });
    expect(a.ok).toBe(true);
    expect(
      await recordFuelFill(app, users.plant, {
        truckId: scene.truckId,
        filledOn: D2,
        litres: '100',
        odometerKm: 199_000,
      }),
    ).toEqual({ ok: false, error: 'ODOMETER' });
    await expect(
      withRlsContext(app, { userId: users.plant.id, role: 'plant', requestId: marker }, (tx) =>
        tx.query(
          `insert into fuel_fill (id, truck_id, filled_on, litres_ml, odometer_km, created_by)
           values (gen_random_uuid(), $1, $2, 100000, 100, $3)`,
          [scene.truckId, D3, users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the report (AC-OPS-22)', () => {
  beforeAll(async () => {
    // truck 1 of the scene: fills with readings and 8 m³ + 4 m³ delivered in the period
    for (const [date, litres, km] of [
      [D2, '120,5', 200_500],
      [D3, '150', 201_000],
    ] as const) {
      const r = await recordFuelFill(app, users.plant, {
        truckId: scene.truckId,
        filledOn: date,
        litres,
        odometerKm: km,
      });
      if (!r.ok) throw new Error(r.error);
    }
    for (const [volumeL, today] of [
      [8000, D2],
      [2000, D3],
    ] as const) {
      const l = await createLoad(
        app,
        users.plant,
        { orderId: scene.orderId, truckId: scene.truckId, volumeL },
        { today },
      );
      if (!l.ok) throw new Error(l.error);
    }
    // fuel bought in the period: 1 000 L for 12 000 MAD (already) + 500 L for 6 300 MAD
    await recordFuelPurchase(app, users.owner, { purchasedOn: D3, litres: '500', totalMad: '6300' });
  });

  it('quantities per truck: litres, km between the first and last odometer, litres per 100 km, litres per m³ delivered', async () => {
    const r = await report(users.plant);
    const t = r.trucks.find((x) => x.truckId === scene.truckId);
    // fills: 100 L (D1), 120,5 L (D2), 150 L (D3): 370,5 L; readings 200 000, 200 500, 201 000: 1 000 km
    expect(t).toMatchObject({ fills: 3, litresMl: 370_500, km: 1000, deliveredL: 10_000 });
    // the first tank is burnt before the first reading: 120,5 + 150 = 270,5 L over 1 000 km = 27,05 L per 100 km
    expect(t?.litresMlOverKm).toBe(270_500);
    expect(t?.mlPer100Km).toBe(27_050);
    // 370,5 L over 10 m³
    expect(t?.mlPerM3).toBe(37_050);
  });

  it('owner and support receive the price and the costs; plant and partner receive no money key at all', async () => {
    for (const role of ['owner', 'support'] as const) {
      const r = await report(users[role]);
      expect(r.money, role).toBeDefined();
      // 1 000 L at 12 000 MAD and 500 L at 6 300 MAD: 18 300 MAD over 1 500 L = 12,20 MAD per litre
      expect(r.money?.price).toMatchObject({
        totalCentimes: 1_830_000,
        litresMl: 1_500_000,
        centimesPerLitre: 1220,
      });
      const cost = r.money?.costs.find((c) => c.truckId === scene.truckId);
      // 370,5 L at 12,20 = 4 520,10 MAD; per m³ delivered: 452,01
      expect(cost).toEqual({ truckId: scene.truckId, costCentimes: 452_010, costPerM3Centimes: 45_201 });
    }
    for (const role of ['plant', 'partner'] as const) {
      const r = await report(users[role]);
      expect('money' in r, role).toBe(false);
      expectNoFields(r, MONEY_FIELDS);
    }
  });

  it('the list of fills carries quantities only', async () => {
    for (const role of ['plant', 'partner', 'support']) {
      const fills = await listFuelFills(app, users[role as 'plant']);
      expect(fills.length).toBeGreaterThan(0);
      expectNoFields(fills, MONEY_FIELDS);
    }
  });

  it('fuel_purchase is invisible to the others: partner and plant read zero rows, the owner and support read them', async () => {
    const count = (role: 'owner' | 'partner' | 'plant' | 'support') =>
      withRlsContext(app, { userId: users[role].id, role, requestId: marker }, async (tx) =>
        Number(
          (
            await tx.query<{ n: string }>(
              `select count(*)::text as n from fuel_purchase where purchased_on between $1 and $2`,
              [D1, D3],
            )
          ).rows[0]?.n,
        ),
      );
    expect(await count('owner')).toBe(2);
    expect(await count('support')).toBe(2);
    expect(await count('partner')).toBe(0);
    expect(await count('plant')).toBe(0);
  });

  it('refuses a bad range', async () => {
    expect(await getFuelReport(app, users.plant, { from: D3, to: D1 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await getFuelReport(app, users.plant, { from: '2026-02-30', to: D1 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });
});
