import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adjustStockAfterCount,
  cancelLoad,
  consumptionForLoad,
  createLoad,
  getConsumptionReport,
  type ConsumptionReportView,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O11: production per type and day, theoretical consumption per component against the counts, flagged above the
// tolerance. AC-OPS-18, 19. A date of its own (far away, random) keeps other suites' loads out of the figures.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `cr${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const year = 2070 + Math.floor(Math.random() * 29);
const month = String(1 + Math.floor(Math.random() * 11)).padStart(2, '0');
const D1 = `${year}-${month}-08`;
const D2 = `${year}-${month}-09`;
const D3 = `${year}-${month}-20`;
let a: DeliveryScene;
let b: DeliveryScene;
const loadIds: string[] = [];
let adjustment = 0;

const report = async (actor: SessionUser, period: 'day' | 'week' | 'month' = 'day', from = D1, to = D3) => {
  const r = await getConsumptionReport(app, actor, { from, to, period });
  if (!r.ok) throw new Error('report');
  return r.value;
};
const cementRow = (r: ConsumptionReportView, period: string) =>
  r.consumption.find((c) => c.componentId === a.cementId && c.period === period);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  a = await deliveryScene(app, users.owner.id, `${marker}a`);
  b = await deliveryScene(app, users.owner.id, `${marker}b`);
  // order a (10 m³): 8 m³ and 2 m³ on D1; order b (another type, 10 m³): 6 m³ on D2
  for (const [scene, volumeL, today] of [
    [a, 8000, D1],
    [a, 2000, D1],
    [b, 6000, D2],
  ] as const) {
    const l = await createLoad(
      app,
      users.plant,
      { orderId: scene.orderId, truckId: scene.truckId, volumeL },
      { today },
    );
    if (!l.ok) throw new Error(l.error);
    loadIds.push(l.value.id);
  }
});

describe('production per type (AC-OPS-18)', () => {
  it('is the sum of the live loads per type and day', async () => {
    const r = await report(users.plant);
    const mine = r.produced.filter((p) => [a.typeId, b.typeId].includes(p.typeId));
    expect(mine.map((p) => [p.period, p.volumeL]).sort()).toEqual([
      [D1, 10_000],
      [D2, 6_000],
    ]);
  });

  it('a cancelled load nets out on the day of the load, not the day it was cancelled', async () => {
    const cancelled = await cancelLoad(
      app,
      users.owner,
      { deliveryId: loadIds[2], reason: 'test cancellation' },
      { today: D3 },
    );
    expect(cancelled.ok).toBe(true);
    const r = await report(users.plant);
    const typeB = r.produced.filter((p) => p.typeId === b.typeId);
    expect(typeB.map((p) => [p.period, p.volumeL])).toEqual([[D2, 0]]);
    // and not a negative figure on D3
    expect(r.produced.some((p) => p.period === D3 && p.volumeL < 0)).toBe(false);
  });

  it('the sum over days equals the sum over weeks and months', async () => {
    const days = await report(users.plant, 'day');
    const weeks = await report(users.plant, 'week');
    const months = await report(users.plant, 'month');
    const total = (r: ConsumptionReportView) =>
      r.produced.filter((p) => [a.typeId, b.typeId].includes(p.typeId)).reduce((s, p) => s + p.volumeL, 0);
    expect(total(days)).toBe(10_000);
    expect(total(weeks)).toBe(10_000);
    expect(total(months)).toBe(10_000);
  });
});

describe('consumption against the counts (AC-OPS-19)', () => {
  it('the theoretical consumption of a day is the recette × the live m³ (350 kg of cement per m³)', async () => {
    const r = await report(users.plant);
    const expected = consumptionForLoad([{ componentId: a.cementId, qtyPerM3: 350_000 }], 8000)[0]?.qtyBase;
    const second = consumptionForLoad([{ componentId: a.cementId, qtyPerM3: 350_000 }], 2000)[0]?.qtyBase;
    expect(cementRow(r, D1)).toMatchObject({
      theoretical: (expected ?? 0) + (second ?? 0),
      counted: false,
      actual: null,
    });
    // the cancelled load of order b took its stock back: nothing is left of it on D2 for the cement of order b's recette
    expect(cementRow(r, D2)?.theoretical).toBe(0);
  });

  it('a count recorded in the period gives the actual figure and the variance; the flag follows the tolerance', async () => {
    const levels = await migrator.query<{ level: string }>(
      `select coalesce(sum(qty_base), 0)::text as level from stock_movement where component_id = $1`,
      [a.cementId],
    );
    // The count finds less than the books say (a count cannot be negative: when other suites left the books below 56 000 g,
    // it finds nothing, and the correction is whatever brings the books to that).
    const level = Number(levels.rows[0]?.level);
    const counted = level - 56_000 >= 0 ? level - 56_000 : level === 0 ? 1 : 0;
    const done = await adjustStockAfterCount(
      app,
      users.owner,
      { componentId: a.cementId, countedBase: counted, reason: 'inventaire du test' },
      { today: D1 },
    );
    if (!done.ok) throw new Error(done.error);
    adjustment = done.value.difference;
    const row = cementRow(await report(users.plant), D1);
    expect(row?.counted).toBe(true);
    expect(row?.adjustments).toBe(adjustment);
    expect(row?.variance).toBe(-adjustment);
    expect(row?.actual).toBe((row?.theoretical ?? 0) - adjustment);
    // flagged exactly when |variance| × 10 000 > tolerance (200) × theoretical
    const theoretical = row?.theoretical ?? 0;
    expect(row?.flagged).toBe(Math.abs(adjustment) * 10_000 > 200 * theoretical);
  });

  it('weekly and monthly figures keep the component apart and add up the day figures', async () => {
    const days = await report(users.plant, 'day');
    const month = await report(users.plant, 'month');
    const d = days.consumption
      .filter((c) => c.componentId === a.cementId)
      .reduce((s, c) => s + c.theoretical, 0);
    const m = month.consumption
      .filter((c) => c.componentId === a.cementId)
      .reduce((s, c) => s + c.theoretical, 0);
    expect(m).toBe(d);
  });
});

describe('who reads it, and what it carries', () => {
  it('owner, partner, plant and support read; office is refused', async () => {
    for (const role of ['owner', 'partner', 'plant', 'support'] as const) {
      expect(
        (await getConsumptionReport(app, users[role], { from: D1, to: D3, period: 'day' })).ok,
        role,
      ).toBe(true);
    }
    await expect(
      getConsumptionReport(app, users.office, { from: D1, to: D3, period: 'day' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('carries no price, total, amount or client field (quantities only)', async () => {
    for (const role of ['plant', 'partner', 'support'] as const) {
      expectNoFields(await report(users[role]), [
        'priceCentimes',
        'unitPriceHtCentimes',
        'totalTtcCentimes',
        'amountCentimes',
        'phone',
        'clientName',
        'clientCode',
        'planItems',
      ]);
    }
  });

  it('refuses bad dates, a reversed range, an unknown period and a range of more than 400 days', async () => {
    for (const input of [
      { from: '2026-02-30', to: D3, period: 'day' },
      { from: D3, to: D1, period: 'day' },
      { from: D1, to: D3, period: 'year' },
      { from: '2020-01-01', to: '2022-01-01', period: 'month' },
    ]) {
      expect(await getConsumptionReport(app, users.plant, input as never)).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
  });

  it('the tolerance is a parameter the plant can reach through the operations door only', async () => {
    const r = await report(users.plant);
    expect(r.toleranceBp).toBe(200);
  });
});
