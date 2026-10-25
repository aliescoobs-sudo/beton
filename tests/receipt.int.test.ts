import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { cancelPurchase, createPurchase } from '../src/modules/ledger';
import { getStockLevels, listReceivable, recordReceipt, setStockThreshold } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// ledger L21 + operations O5: AC-OPS-03 (30 t of cement = +30 000 000 g), a receipt once, quantities only for the plant,
// thresholds and the derived status.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const marker = `rc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-06-10';
let master: PurchaseMaster;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await purchaseMaster(app, users.owner.id, marker);
});

const buy = async (lines: unknown[]) => {
  const r = await createPurchase(
    app,
    users.office,
    { supplierId: master.supplierId, lines },
    { today: '2026-06-01' },
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const cement = (qtyMilli: number) => ({
  componentId: master.componentId,
  purchaseUnitId: master.unitId,
  qtyMilli,
  unitPriceHtCentimes: 145_000,
});
const levelOf = async () =>
  Number(
    (await getStockLevels(app, users.plant)).find((c) => c.componentId === master.componentId)?.level ?? 0,
  );

describe('recordReceipt (AC-OPS-03)', () => {
  it('30 t of cement = +30 000 000 g, recorded by the plant, once', async () => {
    const p = await buy([cement(30_000), { description: 'Transport', unitPriceHtCentimes: 250_000 }]);
    const before = await levelOf();
    const r = await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY });
    if (!r.ok) throw new Error(r.error);
    expect(Object.keys(r.value).sort()).toEqual(['effects', 'receiptId']);
    expect((await levelOf()) - before).toBe(30_000_000);
    expect(await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'ALREADY_RECEIVED',
    });
    expect((await levelOf()) - before).toBe(30_000_000);
    // two lines of the same component add up on one movement
    const q = await buy([cement(1500), cement(2500)]);
    const b2 = await levelOf();
    expect(
      (
        await recordReceipt(
          app,
          users.owner,
          { purchaseId: q.id, receivedDate: '2026-06-05' },
          { today: TODAY },
        )
      ).ok,
    ).toBe(true);
    expect((await levelOf()) - b2).toBe(4_000_000);
  });

  it('two concurrent receipts of the same purchase: exactly one', async () => {
    const p = await buy([cement(1000)]);
    const results = await Promise.all(
      [users.plant, users.owner, users.partner, users.plant].map((u) =>
        recordReceipt(app, u, { purchaseId: p.id }, { today: TODAY }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'ALREADY_RECEIVED')).toBe(true);
  });

  it('refuses a purchase with services only, a cancelled purchase, a future date and an unknown purchase', async () => {
    const services = await buy([{ description: 'Gasoil', unitPriceHtCentimes: 99_000 }]);
    expect(await recordReceipt(app, users.plant, { purchaseId: services.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    const p = await buy([cement(1000)]);
    expect(
      await recordReceipt(
        app,
        users.plant,
        { purchaseId: p.id, receivedDate: '2026-06-11' },
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'FUTURE_DATE' });
    expect(
      await recordReceipt(
        app,
        users.plant,
        { purchaseId: p.id, receivedDate: '2026-05-31' },
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      (await cancelPurchase(app, users.owner, p.id, 'Commande annulée', { today: '2026-06-01' })).ok,
    ).toBe(true);
    expect(await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'PURCHASE_CANCELLED',
    });
    expect(await recordReceipt(app, users.plant, { purchaseId: randomUUID() }, { today: TODAY })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await recordReceipt(app, users.plant, { purchaseId: 'x' }, { today: TODAY })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('a quantity that is not a whole number of base units is refused, never rounded', async () => {
    const unit = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>(
        `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 'g1', 1) returning id`,
        [master.componentId],
      ),
    );
    const p = await buy([
      {
        componentId: master.componentId,
        purchaseUnitId: unit.rows[0]?.id,
        qtyMilli: 1500,
        unitPriceHtCentimes: 100,
      },
    ]);
    expect(await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'FRACTIONAL_QUANTITY',
    });
  });

  it('office cannot receive; the table and the movement cannot be written directly by the plant', async () => {
    const p = await buy([cement(1000)]);
    await expect(
      recordReceipt(app, users.office, { purchaseId: p.id }, { today: TODAY }),
    ).rejects.toBeDefined();
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into purchase_receipt (id, purchase_id, received_date, created_by) values (gen_random_uuid(), $1, '2026-06-02', $2)`,
          [p.id, users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
           values (gen_random_uuid(), $1, '2026-06-02', 5, 'receipt', gen_random_uuid(), $2)`,
          [master.componentId, users.plant.id],
        ),
      ),
    ).rejects.toBeDefined(); // the guard (23514) or the policy (42501) refuses it
    await expect(
      inCtx(users.office, (tx) => tx.query(`select public.record_receipt($1, '2026-06-02')`, [p.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('plant sees quantities only', () => {
  it('lists what to receive with quantities, never a price, total, invoice or due date', async () => {
    const p = await buy([cement(30_000)]);
    for (const role of ['plant', 'partner', 'owner', 'support'] as const) {
      const list = await listReceivable(app, users[role]);
      const mine = list.find((x) => x.purchaseId === p.id);
      expect(mine?.lines).toEqual([
        {
          lineId: expect.any(String),
          nameFr: `ps${marker}`,
          nameAr: 'x',
          unitLabel: 't',
          qtyMilli: 30_000,
          receivedMilli: 0,
        },
      ]);
      expect(mine?.status).toBe('expected');
      expect(mine?.receivedOn).toBeNull();
      expectNoFields(list, [
        'unitPriceHtCentimes',
        'lineHtCentimes',
        'totalTtcCentimes',
        'dueDate',
        'supplierInvoiceNo',
      ]);
    }
    await expect(listReceivable(app, users.office)).rejects.toBeDefined();
  });
});

describe('partial receipts and over-receipts (review of CP-OPS-1-3, point 3)', () => {
  const lineOf = async (purchaseId: string) =>
    (await listReceivable(app, users.owner)).find((x) => x.purchaseId === purchaseId)?.lines[0];

  it('several receipts until the ordered quantity is reached, each adding its stock', async () => {
    const p = await buy([cement(30_000)]);
    const line = await lineOf(p.id);
    if (!line) throw new Error('no line');
    const before = await levelOf();
    const first = await recordReceipt(
      app,
      users.plant,
      { purchaseId: p.id, lines: [{ lineId: line.lineId, qtyMilli: 12_000 }] },
      { today: TODAY },
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect((await levelOf()) - before).toBe(12_000_000);
    expect((await listReceivable(app, users.plant)).find((x) => x.purchaseId === p.id)).toMatchObject({
      status: 'partial',
      receipts: 1,
    });
    // everything still expected: the remaining 18 t, once
    const rest = await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY });
    expect(rest.ok, JSON.stringify(rest)).toBe(true);
    expect((await levelOf()) - before).toBe(30_000_000);
    expect((await listReceivable(app, users.plant)).find((x) => x.purchaseId === p.id)).toMatchObject({
      status: 'complete',
      receipts: 2,
    });
    expect(await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY })).toEqual({
      ok: false,
      error: 'ALREADY_RECEIVED',
    });
  });

  it('more than ordered needs the owner and his confirmation; the receipt is flagged', async () => {
    const p = await buy([cement(10_000)]);
    const line = await lineOf(p.id);
    if (!line) throw new Error('no line');
    const over = { purchaseId: p.id, lines: [{ lineId: line.lineId, qtyMilli: 10_500 }] };
    const before = await levelOf();
    for (const user of [users.plant, users.partner]) {
      expect(await recordReceipt(app, user, { ...over, confirmExcess: true }, { today: TODAY })).toEqual({
        ok: false,
        error: 'EXCESS_NEEDS_OWNER',
      });
    }
    expect(await recordReceipt(app, users.owner, over, { today: TODAY })).toEqual({
      ok: false,
      error: 'EXCESS_NEEDS_OWNER',
    });
    expect(await levelOf()).toBe(before);
    const ok = await recordReceipt(app, users.owner, { ...over, confirmExcess: true }, { today: TODAY });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect((await levelOf()) - before).toBe(10_500_000);
    const flagged = await inCtx(users.owner, (tx) =>
      tx.query<{ over_receipt: boolean }>(
        'select over_receipt from purchase_receipt where purchase_id = $1',
        [p.id],
      ),
    );
    expect(flagged.rows).toEqual([{ over_receipt: true }]);
  });

  it('refuses a line of another purchase, a zero quantity and a fraction of a base unit', async () => {
    const p = await buy([cement(10_000)]);
    const other = await buy([cement(10_000)]);
    const foreign = await lineOf(other.id);
    const line = await lineOf(p.id);
    if (!foreign || !line) throw new Error('no line');
    const call = (lines: unknown[]) =>
      recordReceipt(app, users.plant, { purchaseId: p.id, lines }, { today: TODAY });
    expect((await call([{ lineId: foreign.lineId, qtyMilli: 1_000 }])).ok).toBe(false);
    expect((await call([{ lineId: line.lineId, qtyMilli: 0 }])).ok).toBe(false);
    expect(
      (
        await call([
          { lineId: line.lineId, qtyMilli: 1_000 },
          { lineId: line.lineId, qtyMilli: 1_000 },
        ])
      ).ok,
    ).toBe(false);
    expect(await levelOf()).toBeGreaterThanOrEqual(0);
  });

  it('the receipt lines are quantities only: plant and partner read them, office does not, nobody writes them directly', async () => {
    const p = await buy([cement(10_000)]);
    await recordReceipt(app, users.plant, { purchaseId: p.id }, { today: TODAY });
    for (const role of ['plant', 'partner', 'owner', 'support'] as const) {
      expect(
        (await inCtx(users[role], (tx) => tx.query('select 1 from purchase_receipt_line'))).rows.length,
        role,
      ).toBeGreaterThan(0);
    }
    expect((await inCtx(users.office, (tx) => tx.query('select 1 from purchase_receipt_line'))).rows).toEqual(
      [],
    );
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into purchase_receipt_line (id, receipt_id, purchase_line_id, qty_milli) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('thresholds and the derived status (O5)', () => {
  it('low below the threshold, ok above, short below zero; only owner and partner set it', async () => {
    const level = await levelOf();
    expect(
      await setStockThreshold(app, users.plant, { componentId: master.componentId, lowQtyBase: 5 }).catch(
        () => 'refused',
      ),
    ).toBe('refused');
    const set = await setStockThreshold(app, users.partner, {
      componentId: master.componentId,
      lowQtyBase: level + 1000,
    });
    expect(set.ok).toBe(true);
    const low = (await getStockLevels(app, users.plant)).find((c) => c.componentId === master.componentId);
    expect(low).toMatchObject({ lowThreshold: level + 1000, status: 'low' });
    expect(
      (
        await setStockThreshold(app, users.owner, {
          componentId: master.componentId,
          lowQtyBase: Math.max(1, level - 1000),
        })
      ).ok,
    ).toBe(true);
    const ok = (await getStockLevels(app, users.plant)).find((c) => c.componentId === master.componentId);
    expect(ok?.status).toBe('ok');
    expect(await setStockThreshold(app, users.owner, { componentId: randomUUID(), lowQtyBase: 5 })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(
      await setStockThreshold(app, users.owner, { componentId: master.componentId, lowQtyBase: 0 }),
    ).toEqual({ ok: false, error: 'INVALID' });
  });
});
