import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrder } from '../src/modules/ledger';
import { listGridInForce } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { orderMaster } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * T17 (SPEC-cost-margin §6, §9, §10; D239 to D243): the grid reference (G8), the margin read doors (G9), the pump check (G10), the fuel check (G11).
 * Fictitious A1 data; refusals assert the SQLSTATE; no cost, margin or snapshot is ever shown to a role outside owner and app_admin.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `t17a${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const call = (u: U, sql: string, params: unknown[] = []) => w.as(u, (tx) => tx.query(sql, params));

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('T17 G8: the grid is a reference (D239)', () => {
  it('owner, app_admin and office_sales read the grid in force; every other role gets nothing and the door itself refuses them', async () => {
    for (const u of [w.owner, w.appAdmin, w.sales]) {
      const g = await listGridInForce(app, u as unknown as SessionUser, '2099-01-01');
      expect(g.length, u.role).toBeGreaterThan(0);
      expect(g.every((x) => x.priceCentimes > 0 && ['GOULOTTE', 'POMPE'].includes(x.method))).toBe(true);
      // one row per (class, method): the latest version in force
      expect(new Set(g.map((x) => `${x.classCode}|${x.method}`)).size).toBe(g.length);
    }
    for (const u of [w.pmA, w.purchases, w.accountant, w.partner, w.support, w.driverUserA]) {
      expect(await listGridInForce(app, u as unknown as SessionUser, '2099-01-01'), u.role).toEqual([]);
      expect(await code(() => call(u, 'select * from public.price_grid_list()')), u.role).toBe('42501');
    }
    // before the first version there is no price in force
    expect(await listGridInForce(app, w.owner as unknown as SessionUser, '1999-01-01')).toEqual([]);
  });

  it('the grid price is never written into selling_price: an order is priced by selling_price whatever the grid says', async () => {
    const m = { ...(await orderMaster(app, w.owner.id, `${marker}a`)), clientId: w.scene.clientId };
    const before = (await w.sup<{ c: string }>('select count(*)::text c from selling_price'))[0]!.c;
    const made = await createOrder(
      app,
      w.owner as unknown as SessionUser,
      {
        clientId: m.clientId,
        plantId: w.plantA,
        concreteTypeId: m.typeId,
        dischargeMethod: 'POMPE',
        volumeL: 5000,
        deliveryDate: '2026-06-03',
        plan: { preset: 'cash' },
      },
      { today: '2026-06-01' },
    );
    if (!made.ok) throw new Error(made.error);
    const o = (
      await w.sup<{ unit: string; sp: string; m: string }>(
        `select o.unit_price_ht_centimes::text unit, p.price_ht_per_m3_centimes::text sp, o.discharge_method m
           from sales_order o join selling_price p on p.id = o.selling_price_id where o.id = $1`,
        [made.value.id],
      )
    )[0]!;
    expect(o.m).toBe('POMPE');
    // the order's price is the selling price, to the centime, and the grid left selling_price untouched
    expect(o.unit).toBe(o.sp);
    expect((await w.sup<{ c: string }>('select count(*)::text c from selling_price'))[0]!.c).toBe(before);
  });
});
