import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelLoad,
  consumptionForLoad,
  createLoad,
  getConsumptionReport,
  listDeliveries,
  recordLoss,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O14: concrete returned or refused, recorded per load with a reason, counted as loss in the consumption report.
// AC-OPS-23. A far, random date keeps other suites' loads out of the figures.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `lo${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const year = 2010 + Math.floor(Math.random() * 29);
const month = String(1 + Math.floor(Math.random() * 11)).padStart(2, '0');
const DAY = `${year}-${month}-14`;
let scene: DeliveryScene;
const loads: Record<string, string> = {};

const load = async (volumeL: number, orderScene = scene): Promise<string> => {
  const l = await createLoad(
    app,
    users.plant,
    { orderId: orderScene.orderId, truckId: orderScene.truckId, volumeL },
    { today: DAY },
  );
  if (!l.ok) throw new Error(l.error);
  return l.value.id;
};
const report = async () => {
  const r = await getConsumptionReport(app, users.plant, { from: DAY, to: DAY, period: 'day' });
  if (!r.ok) throw new Error('report');
  return r.value;
};

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  loads.a = await load(8000);
  loads.b = await load(2000);
});

describe('who records a loss, and the rules (AC-OPS-23)', () => {
  it('support is refused; plant, office, partner and owner record', async () => {
    await expect(
      recordLoss(app, users.support, { deliveryId: loads.a, reason: 'quality' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const cases = ['partner', 'owner'] as const;
    for (const role of cases) {
      const own = await load(500);
      expect(
        (await recordLoss(app, users[role], { deliveryId: own, reason: 'other', note: 'test' })).ok,
        role,
      ).toBe(true);
    }
  });

  it('a loss is recorded once per load with a reason, a volume of at most the load; the default is the whole load', async () => {
    const first = await recordLoss(app, users.plant, {
      deliveryId: loads.a,
      volumeL: 3000,
      reason: 'rejected_by_client',
    });
    expect(first).toMatchObject({ ok: true, value: { volumeL: 3000 } });
    expect(await recordLoss(app, users.office, { deliveryId: loads.a, reason: 'quality' })).toEqual({
      ok: false,
      error: 'ALREADY_RECORDED',
    });
    const whole = await recordLoss(app, users.office, { deliveryId: loads.b, reason: 'too_old' });
    expect(whole).toMatchObject({ ok: true, value: { volumeL: 2000 } });
  });

  it('refuses more than the load, an unknown reason, an unknown load, a malformed id', async () => {
    const own = await load(1000);
    expect(await recordLoss(app, users.plant, { deliveryId: own, volumeL: 1001, reason: 'quality' })).toEqual(
      {
        ok: false,
        error: 'OVER_LOAD',
      },
    );
    expect(await recordLoss(app, users.plant, { deliveryId: own, reason: 'because' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await recordLoss(app, users.plant, { deliveryId: randomUUID(), reason: 'quality' })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await recordLoss(app, users.plant, { deliveryId: 'x', reason: 'quality' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('a cancelled load cannot be marked, by the service and by the database', async () => {
    const own = await load(1000);
    const cancelled = await cancelLoad(
      app,
      users.owner,
      { deliveryId: own, reason: 'test cancellation' },
      { today: DAY },
    );
    expect(cancelled.ok).toBe(true);
    expect(await recordLoss(app, users.plant, { deliveryId: own, reason: 'quality' })).toEqual({
      ok: false,
      error: 'NOT_LIVE',
    });
    await expect(
      withRlsContext(app, { userId: users.plant.id, role: 'plant', requestId: marker }, (tx) =>
        tx.query(
          `insert into delivery_loss (id, delivery_id, volume_l, reason, created_by) values (gen_random_uuid(), $1, 10, 'quality', $2)`,
          [own, users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('delivery_loss has no UPDATE or DELETE for the application role', async () => {
    const { rows } = await migrator.query<{ u: boolean; d: boolean }>(
      `select has_table_privilege('belgobeton_app', 'public.delivery_loss', 'UPDATE') as u,
              has_table_privilege('belgobeton_app', 'public.delivery_loss', 'DELETE') as d`,
    );
    expect(rows[0]).toEqual({ u: false, d: false });
  });
});

describe('counted as loss in the consumption report (AC-OPS-23)', () => {
  it('the lost litres appear per type and day, and the theoretical consumption does not change', async () => {
    const r = await report();
    const mine = r.loss.produced.filter((p) => p.typeId === scene.typeId);
    // 3 m³ of load A (rejected by the client) + the whole 2 m³ of load B (too old), plus the partner and owner test loads (500 L each)
    expect(mine.reduce((s, p) => s + p.volumeL, 0)).toBe(3000 + 2000 + 500 + 500);
    // produced = everything loaded that day and not cancelled (8 + 2 + 0,5 + 0,5 + the 1 m³ load of the over-load test),
    // so the loss is inside it, not taken off it
    const produced = r.produced.filter((p) => p.typeId === scene.typeId).reduce((s, p) => s + p.volumeL, 0);
    expect(produced).toBe(8000 + 2000 + 500 + 500 + 1000);
    // theoretical cement = recette (350 kg/m³) × litres loaded and live, loss or not
    const cement = r.consumption.find((c) => c.componentId === scene.cementId);
    const lines = [{ componentId: scene.cementId, qtyPerM3: 350_000 }];
    const loaded = [8000, 2000, 500, 500, 1000].reduce(
      (s, v) => s + (consumptionForLoad(lines, v)[0]?.qtyBase ?? 0),
      0,
    );
    expect(cement?.theoretical).toBe(loaded);
  });

  it('the components the lost concrete used are the recette applied to the lost litres', async () => {
    const r = await report();
    const lines = [{ componentId: scene.cementId, qtyPerM3: 350_000 }];
    const expected = [3000, 2000, 500, 500].reduce(
      (s, v) => s + (consumptionForLoad(lines, v)[0]?.qtyBase ?? 0),
      0,
    );
    const lost = r.loss.components.find((c) => c.componentId === scene.cementId);
    expect(lost?.qtyBase).toBe(expected);
    // never more than what was consumed
    const cement = r.consumption.find((c) => c.componentId === scene.cementId);
    expect(lost?.qtyBase ?? 0).toBeLessThanOrEqual(cement?.theoretical ?? 0);
  });

  it('a loss of a cancelled load is not counted', async () => {
    // the 1 000 L load of the previous suite step was cancelled before any loss: nothing of it is in the figures
    const r = await report();
    expect(r.loss.produced.filter((p) => p.typeId === scene.typeId).reduce((s, p) => s + p.volumeL, 0)).toBe(
      6000,
    );
  });

  it('the delivery list shows the loss on its load, quantities only', async () => {
    const list = await listDeliveries(app, users.plant, 200);
    const a = list.find((d) => d.id === loads.a);
    expect(a?.loss).toEqual({ volumeL: 3000, reason: 'rejected_by_client' });
    expect(list.find((d) => d.id === loads.b)?.loss).toMatchObject({ volumeL: 2000, reason: 'too_old' });
    expectNoFields(list, ['priceCentimes', 'amountCentimes', 'totalTtcCentimes', 'phone', 'clientName']);
  });
});
