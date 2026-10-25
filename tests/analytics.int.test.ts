import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelLoad, createLoad, getVolumeAnalytics, type VolumeAnalytics } from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O15: m³ delivered per day, week and month, per client, type and zone; amounts for owner and support only.
// AC-OPS-24. A far, random period keeps other suites' loads out of the figures.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `an${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const year = 2030 + Math.floor(Math.random() * 60);
const month = String(1 + Math.floor(Math.random() * 11)).padStart(2, '0');
const D1 = `${year}-${month}-03`;
const D2 = `${year}-${month}-04`;
const D3 = `${year}-${month}-17`;
let a: DeliveryScene;
let b: DeliveryScene;
let codeA = '';
let codeB = '';
const cancelled: string[] = [];

const ask = async (
  actor: SessionUser,
  period: 'day' | 'week' | 'month',
  dimension: 'client' | 'type' | 'zone',
): Promise<VolumeAnalytics> => {
  const r = await getVolumeAnalytics(app, actor, { from: D1, to: D3, period, dimension });
  if (!r.ok) throw new Error('analytics');
  return r.value;
};
const load = async (scene: DeliveryScene, volumeL: number, today: string) => {
  const l = await createLoad(
    app,
    users.plant,
    { orderId: scene.orderId, truckId: scene.truckId, volumeL },
    { today },
  );
  if (!l.ok) throw new Error(l.error);
  return l.value.id;
};

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  a = await deliveryScene(app, users.owner.id, `${marker}a`);
  b = await deliveryScene(app, users.owner.id, `${marker}b`);
  const codes = await migrator.query<{ id: string; code: string }>(
    `select o.id, c.code from sales_order o join client c on c.id = o.client_id where o.id = any($1::uuid[])`,
    [[a.orderId, b.orderId]],
  );
  codeA = codes.rows.find((r) => r.id === a.orderId)?.code as string;
  codeB = codes.rows.find((r) => r.id === b.orderId)?.code as string;
  // order a: 8 m³ on D1 and 2 m³ on D3; order b: 6 m³ on D2, then the 6 m³ load of D2 is cancelled and 4 m³ go on D2
  await load(a, 8000, D1);
  await load(a, 2000, D3);
  const gone = await load(b, 6000, D2);
  const c = await cancelLoad(
    app,
    users.owner,
    { deliveryId: gone, reason: 'test cancellation' },
    { today: D3 },
  );
  if (!c.ok) throw new Error(c.error);
  cancelled.push(gone);
  await load(b, 4000, D2);
});

describe('quantities (AC-OPS-24)', () => {
  it('m³ per day and type are the sum of the live loads; a cancellation counts on the day of its load', async () => {
    const r = await ask(users.partner, 'day', 'type');
    const mine = r.volume.filter((v) => [a.typeId, b.typeId].includes(v.key));
    expect(mine.map((v) => [v.period, v.volumeL]).sort()).toEqual([
      [D1, 8000],
      [D2, 4000],
      [D3, 2000],
    ]);
  });

  it('per client, the client codes group the loads of each order', async () => {
    const r = await ask(users.partner, 'month', 'client');
    expect(r.volume.find((v) => v.label === codeA)?.volumeL).toBe(10_000);
    expect(r.volume.find((v) => v.label === codeB)?.volumeL).toBe(4_000);
  });

  it('per zone: an order whose site has no zone falls in the "no zone" row', async () => {
    const r = await ask(users.partner, 'month', 'zone');
    expect(r.volume.some((v) => v.label === '—' && v.volumeL >= 14_000)).toBe(true);
  });

  it('the sum over days, weeks and months is the same', async () => {
    const total = (r: VolumeAnalytics) =>
      r.volume.filter((v) => [a.typeId, b.typeId].includes(v.key)).reduce((s, v) => s + v.volumeL, 0);
    const days = await ask(users.owner, 'day', 'type');
    const weeks = await ask(users.owner, 'week', 'type');
    const months = await ask(users.owner, 'month', 'type');
    expect(total(days)).toBe(14_000);
    expect(total(weeks)).toBe(14_000);
    expect(total(months)).toBe(14_000);
  });
});

describe('amounts: owner and support only (AC-OPS-24)', () => {
  it('owner and support get the amount at the order price (780,00 per m³ HT), one rounding per load; a cancelled load takes its amount back', async () => {
    for (const role of ['owner', 'support'] as const) {
      const r = await ask(users[role], 'day', 'type');
      expect(r.amounts, role).toBeDefined();
      const row = (period: string, key: string) =>
        r.amounts?.find((x) => x.period === period && x.key === key);
      // 8 m³ × 780,00 = 6 240,00; 4 m³ = 3 120,00 (the 6 m³ load was cancelled); 2 m³ = 1 560,00
      expect(row(D1, a.typeId)?.amountHtCentimes).toBe(624_000);
      expect(row(D2, b.typeId)?.amountHtCentimes).toBe(312_000);
      expect(row(D3, a.typeId)?.amountHtCentimes).toBe(156_000);
    }
  });

  it('the partner gets quantities and no amount field at all; plant and office are refused', async () => {
    const r = await ask(users.partner, 'month', 'client');
    expect('amounts' in r).toBe(false);
    expectNoFields(r, [
      'amounts',
      'amountHtCentimes',
      'unitPriceHtCentimes',
      'priceCentimes',
      'totalTtcCentimes',
      'amountCentimes',
    ]);
    for (const role of ['plant', 'office'] as const) {
      await expect(
        getVolumeAnalytics(app, users[role], { from: D1, to: D3, period: 'day', dimension: 'type' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('the amounts add up to the loads: Σ amounts = 8 × 780 + 4 × 780 + 2 × 780 over the period', async () => {
    const r = await ask(users.owner, 'month', 'type');
    const sum = (r.amounts ?? [])
      .filter((x) => [a.typeId, b.typeId].includes(x.key))
      .reduce((s, x) => s + (x.amountHtCentimes as number), 0);
    expect(sum).toBe(1_092_000);
  });

  it('refuses a bad range, an unknown period or dimension, and more than 800 days', async () => {
    for (const input of [
      { from: D3, to: D1, period: 'day', dimension: 'type' },
      { from: '2026-02-30', to: D3, period: 'day', dimension: 'type' },
      { from: D1, to: D3, period: 'year', dimension: 'type' },
      { from: D1, to: D3, period: 'day', dimension: 'driver' },
      { from: '2000-01-01', to: '2030-01-01', period: 'month', dimension: 'type' },
    ]) {
      expect(await getVolumeAnalytics(app, users.owner, input as never)).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
  });
});
