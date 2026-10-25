import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createSupplier, listSuppliers, updateSupplier } from '../src/modules/master-data';
import { loadStockFacts, loadReorder, engineParams, type ReorderView } from '../src/modules/rules-engine';
import { defaultParameters } from '../src/modules/platform-security/domain/parameters';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import {
  insertOrder,
  insertPurchase,
  orderMaster,
  purchaseMaster,
  type PurchaseMaster,
} from './helpers/ledger-fixtures';

// operations O12: supplier lead time, days of cover from the open orders, the draft purchase. AC-OPS-20, 21.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `ro${randomUUID().replace(/-/g, '').slice(0, 10)}`;
// Monday 2 November 2026 and the day after: two working days.
const TODAY = '2026-11-02';
const D1 = '2026-11-03';
let pm: PurchaseMaster;
let supplierName = '';
let purchasesBefore = 0;

const params = () => engineParams(defaultParameters());
const row = (v: ReorderView) => v.reorders.find((r) => r.componentId === pm.componentId);
const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  pm = await purchaseMaster(app, users.owner.id, marker);
  supplierName = `ps${marker}`;
  const master = await orderMaster(app, users.owner.id, marker);
  await asOwner(async (tx) => {
    // a recette in force that takes 2 t of the component per m³, so each order of 10 m³ takes 20 t
    const recette = await tx.query<{ id: string }>(
      `insert into recette (id, concrete_type_id, version, effective_from, created_by)
       values (gen_random_uuid(), $1, 1, '2000-01-01', $2) returning id`,
      [master.typeId, users.owner.id],
    );
    await tx.query(
      `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, $2, 2000000)`,
      [recette.rows[0]?.id, pm.componentId],
    );
    // a purchase of 30 t, not received yet: expected on the day (it also makes the supplier the component's usual one)
    await insertPurchase(tx, users.owner.id, pm);
    // two orders of 10 m³: the first on the day, the second the day after
    await insertOrder(tx, users.owner.id, master, TODAY);
    await insertOrder(tx, users.owner.id, master, D1);
  });
  purchasesBefore = Number(
    (await migrator.query<{ n: string }>(`select count(*)::text as n from purchase`)).rows[0]?.n,
  );
});

describe('the supplier lead time (AC-OPS-20)', () => {
  it('is optional, saved with the supplier, and bounded 0 to 120 days', async () => {
    const created = await createSupplier(app, users.owner, { name: `Lead ${marker}`, category: 'cement' });
    if (!created.ok) throw new Error(created.error);
    expect(created.value.leadTimeDays).toBeNull();
    const base = { name: `Lead ${marker}`, category: 'cement' };
    const set = await updateSupplier(app, users.office, created.value.id, { ...base, leadTimeDays: 3 });
    expect(set).toMatchObject({ ok: true, value: { leadTimeDays: 3 } });
    expect(
      (await listSuppliers(app, users.office)).find((s) => s.id === created.value.id)?.leadTimeDays,
    ).toBe(3);
    for (const bad of [-1, 121, 1.5, 'abc']) {
      expect(
        await updateSupplier(app, users.owner, created.value.id, { ...base, leadTimeDays: bad }),
      ).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
    // an empty field clears it
    const cleared = await updateSupplier(app, users.owner, created.value.id, { ...base, leadTimeDays: '' });
    expect(cleared).toMatchObject({ ok: true, value: { leadTimeDays: null } });
  });

  it('the owner reads it with the preferred supplier of a component; plant and partner get no supplier at all', async () => {
    await asOwner((tx) => tx.query(`update supplier set lead_time_days = 3 where id = $1`, [pm.supplierId]));
    const owner = await loadStockFacts(app, users.owner, TODAY, { horizonDays: 14, purchaseLeadDays: 2 });
    expect(owner.suppliers.get(pm.componentId)).toMatchObject({ supplierName, leadTimeDays: 3 });
    for (const role of ['plant', 'partner'] as const) {
      const facts = await loadStockFacts(app, users[role], TODAY, { horizonDays: 14, purchaseLeadDays: 2 });
      expect(facts.suppliers.size, role).toBe(0);
    }
  });
});

describe('days of cover and the draft (AC-OPS-20, 21)', () => {
  it('30 t expected, 20 t on the day and 20 t the next day: the stock is below zero the next day, a cover of 1 day', async () => {
    const view = await loadReorder(app, users.owner, { today: TODAY, params: params() });
    const r = row(view);
    expect(r).toMatchObject({
      coverDays: 1,
      shortageDate: D1,
      leadDays: 3,
      leadFrom: 'supplier',
      needsOrder: true,
    });
    // 1 < 3 + 2 safety days: time to order; the shortage is tomorrow and the lead time is 3 days, so already late
    expect(r?.late).toBe(true);
  });

  it('the draft brings the worst level back to zero: 10 t, at the last price, from the component usual supplier', async () => {
    const r = row(await loadReorder(app, users.owner, { today: TODAY, params: params() }));
    expect(r?.draft).toMatchObject({ supplierName, unitLabel: 't', qtyMilli: 10_000, qtyBase: 10_000_000 });
    // 10 t at 1 450,00 per t
    expect(r?.draft?.estimatedHtCentimes).toBe(1_450_000);
  });

  it('support reads the same draft; plant and partner read the cover and the order-by date but no supplier, price or draft', async () => {
    expect(
      row(await loadReorder(app, users.support, { today: TODAY, params: params() }))?.draft?.supplierName,
    ).toBe(supplierName);
    for (const role of ['plant', 'partner'] as const) {
      const view = await loadReorder(app, users[role], { today: TODAY, params: params() });
      const r = row(view);
      expect(r, role).toMatchObject({ coverDays: 1, needsOrder: true, draft: null, leadFrom: 'parameter' });
      expectNoFields(view, [
        'supplierName',
        'supplierCode',
        'supplierId',
        'estimatedHtCentimes',
        'lastUnitPriceHt',
        'unitPriceHtCentimes',
        'amountCentimes',
        'termDays',
      ]);
    }
  });

  it('a supplier without a lead time uses the parameter', async () => {
    await asOwner((tx) =>
      tx.query(`update supplier set lead_time_days = null where id = $1`, [pm.supplierId]),
    );
    const r = row(await loadReorder(app, users.owner, { today: TODAY, params: params() }));
    expect(r).toMatchObject({ leadFrom: 'parameter', leadDays: defaultParameters().purchase_lead_days });
  });

  it('a margin of zero and a lead time of zero do not trigger: the cover (1 day) is not shorter than 0', async () => {
    await asOwner((tx) => tx.query(`update supplier set lead_time_days = 0 where id = $1`, [pm.supplierId]));
    const r = row(
      await loadReorder(app, users.owner, { today: TODAY, params: { ...params(), reorderMarginDays: 0 } }),
    );
    expect(r).toMatchObject({ coverDays: 1, leadDays: 0, needsOrder: false, draft: null });
  });

  it('is a draft only: reading the suggestion creates no purchase', async () => {
    const after = Number(
      (await migrator.query<{ n: string }>(`select count(*)::text as n from purchase`)).rows[0]?.n,
    );
    expect(after).toBe(purchasesBefore);
  });
});
