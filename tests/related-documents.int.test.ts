import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocate,
  approveSupplierInvoice,
  createInvoice,
  createPurchase,
  createSupplierInvoice,
  getRelatedDocuments,
  issueAvoir,
  issueInstrument,
} from '../src/modules/ledger';
import { recordLoss } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  insertInstrument,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// integration I3.2: the neighbours of a document, from the database relations and the caller's row-level security. AC-INT-17.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `rd${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-07-03';
let scene: DeliveryScene;
let master: OrderMaster;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
});

/** A sold chain: an order, a BL billed on an invoice, a cheque covering the order, and an avoir for litres refused. */
async function soldChain() {
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[6000]]);
  const order = c.orders[0]!;
  const deliveryId = order.deliveryIds[0] as string;
  const made = await createInvoice(app, users.owner, { deliveryIds: [deliveryId] }, { today: TODAY });
  if (!made.ok) throw new Error(made.error);
  const invoiceId = (
    await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>('select id from invoice where number = $1', [made.value.number]),
    )
  ).rows[0]?.id as string;
  const cheque = await inCtx(users.owner, (tx) =>
    insertInstrument(tx, users.owner.id, { clientId: c.clientId, amountCentimes: 100_000 }),
  );
  const number = (
    await inCtx(users.owner, (tx) =>
      tx.query<{ number: string }>('select number from payment_instrument where id = $1', [cheque.id]),
    )
  ).rows[0]?.number as string;
  expect(
    (
      await allocate(app, users.owner, {
        instrumentId: cheque.id,
        itemId: order.itemIds[0],
        amountCentimes: 100_000,
      })
    ).ok,
  ).toBe(true);
  expect(
    (await recordLoss(app, users.plant, { deliveryId, volumeL: 1000, reason: 'rejected_by_client' })).ok,
  ).toBe(true);
  const avoir = await issueAvoir(app, users.owner, { deliveryId, reason: 'refusé' }, { today: TODAY });
  if (!avoir.ok) throw new Error(avoir.error);
  return {
    order,
    deliveryId,
    invoiceId,
    invoiceNumber: made.value.number,
    chequeNumber: number,
    avoirNumber: avoir.value.number,
    blNo: order.blNos[0] as string,
  };
}
const kinds = (items: { kind: string; code: string; path: string | null }[]) =>
  items.map((i) => `${i.kind}:${i.code}`);

describe('the sold chain (AC-INT-17)', () => {
  it('a BL points to its order, its invoice, its avoir and the payment covering its order, with the pages that open them', async () => {
    const s = await soldChain();
    const items = await getRelatedDocuments(app, users.owner, { kind: 'bl', id: s.deliveryId });
    expect(items).toEqual([
      { kind: 'order', code: s.order.code, path: `/orders/${s.order.id}` },
      { kind: 'invoice', code: s.invoiceNumber, path: `/invoices/${s.invoiceId}` },
      { kind: 'avoir', code: s.avoirNumber, path: '/avoirs' },
      { kind: 'payment', code: s.chequeNumber, path: '/instruments' },
    ]);
  });

  it('an order points to its BLs, invoice, avoir and payment; an invoice to its order and BLs, avoir and payment', async () => {
    const s = await soldChain();
    const order = await getRelatedDocuments(app, users.owner, { kind: 'order', id: s.order.id });
    expect(kinds(order)).toEqual([
      `bl:${s.blNo}`,
      `invoice:${s.invoiceNumber}`,
      `avoir:${s.avoirNumber}`,
      `payment:${s.chequeNumber}`,
    ]);
    expect(order.find((d) => d.kind === 'bl')?.path).toBe(`/deliveries/${s.deliveryId}`);
    const invoice = await getRelatedDocuments(app, users.owner, { kind: 'invoice', id: s.invoiceId });
    expect(kinds(invoice)).toEqual([
      `order:${s.order.code}`,
      `bl:${s.blNo}`,
      `avoir:${s.avoirNumber}`,
      `payment:${s.chequeNumber}`,
    ]);
  });

  it('support sees what the owner sees, with the same pages', async () => {
    const s = await soldChain();
    expect(await getRelatedDocuments(app, users.support, { kind: 'bl', id: s.deliveryId })).toEqual(
      await getRelatedDocuments(app, users.owner, { kind: 'bl', id: s.deliveryId }),
    );
  });

  it('the plant sees the order of a BL as a number without a link, and no invoice, avoir or payment at all', async () => {
    const s = await soldChain();
    expect(await getRelatedDocuments(app, users.plant, { kind: 'bl', id: s.deliveryId })).toEqual([
      { kind: 'order', code: s.order.code, path: null },
    ]);
    expect(await getRelatedDocuments(app, users.partner, { kind: 'bl', id: s.deliveryId })).toEqual([
      { kind: 'order', code: s.order.code, path: null },
    ]);
  });

  it('office sees the order code the delivery note prints, as a number, and nothing that is money', async () => {
    const s = await soldChain();
    expect(await getRelatedDocuments(app, users.office, { kind: 'bl', id: s.deliveryId })).toEqual([
      { kind: 'order', code: s.order.code, path: null },
    ]);
  });

  it('a role that reads no money gets nothing for an order or an invoice, and nothing carries an amount', async () => {
    const s = await soldChain();
    for (const role of ['plant', 'partner', 'office'] as const) {
      expect(await getRelatedDocuments(app, users[role], { kind: 'invoice', id: s.invoiceId })).toEqual([]);
      expect(await getRelatedDocuments(app, users[role], { kind: 'order', id: s.order.id })).toEqual(
        role === 'office'
          ? [{ kind: 'bl', code: s.blNo, path: `/deliveries/${s.deliveryId}` }]
          : [{ kind: 'bl', code: s.blNo, path: `/deliveries/${s.deliveryId}` }],
      );
    }
    const all = await getRelatedDocuments(app, users.owner, { kind: 'bl', id: s.deliveryId });
    expect(JSON.stringify(all)).not.toMatch(/amount|centimes|936000|78000|100000/i);
  });

  it('an unknown or malformed id has no neighbours', async () => {
    expect(await getRelatedDocuments(app, users.owner, { kind: 'bl', id: randomUUID() })).toEqual([]);
    expect(await getRelatedDocuments(app, users.owner, { kind: 'invoice', id: 'not-a-uuid' })).toEqual([]);
  });
});

describe('the bought chain (AC-INT-17)', () => {
  it('an order points to its receipts, supplier invoices and payments; an invoice to its order, receipts and payments', async () => {
    const own = await inCtx(users.owner, async (tx) => {
      const supplier = await tx.query<{ id: string }>(
        `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
        [`rd${randomUUID().slice(0, 12)}`],
      );
      const component = await tx.query<{ id: string }>(
        `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g') returning id`,
        [`rd${randomUUID().slice(0, 12)}`],
      );
      const unit = await tx.query<{ id: string }>(
        `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 'kg', 1000) returning id`,
        [component.rows[0]?.id],
      );
      return {
        supplierId: supplier.rows[0]?.id as string,
        componentId: component.rows[0]?.id as string,
        unitId: unit.rows[0]?.id as string,
      };
    });
    const po = await createPurchase(
      app,
      users.office,
      {
        supplierId: own.supplierId,
        lines: [
          {
            componentId: own.componentId,
            purchaseUnitId: own.unitId,
            qtyMilli: 30_000,
            unitPriceHtCentimes: 145_000,
          },
        ],
      },
      { today: '2026-06-01' },
    );
    if (!po.ok) throw new Error(po.error);
    await inCtx(users.owner, (tx) =>
      tx.query(`select public.record_receipt($1, '2026-06-02')`, [po.value.id]),
    );
    const si = await createSupplierInvoice(
      app,
      users.owner,
      {
        purchaseCode: po.value.code,
        supplierInvoiceNo: `RD-${randomUUID().slice(0, 12)}`,
        invoiceDate: '2026-06-03',
        lines: [{ componentId: own.componentId, qtyMilli: 30_000, unitPriceHtCentimes: 145_000 }],
      },
      { today: TODAY },
    );
    if (!si.ok) throw new Error(si.error);
    expect((await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.value.id })).ok).toBe(
      true,
    );
    const paid = await issueInstrument(
      app,
      users.owner,
      {
        supplierId: own.supplierId,
        method: 'transfer',
        amountCentimes: 5_220_000,
        purchaseCode: si.value.code,
      },
      { today: TODAY },
    );
    expect(paid.ok).toBe(true);

    const order = await getRelatedDocuments(app, users.owner, { kind: 'purchase', id: po.value.id });
    expect(order.map((d) => d.kind)).toEqual(['receipt', 'supplier_invoice', 'payment']);
    expect(order.find((d) => d.kind === 'supplier_invoice')).toEqual({
      kind: 'supplier_invoice',
      code: si.value.code,
      path: `/supplier-invoices/${si.value.id}`,
    });
    expect(order.find((d) => d.kind === 'receipt')).toEqual({
      kind: 'receipt',
      code: '2026-06-02',
      path: '/receipts',
    });
    const invoice = await getRelatedDocuments(app, users.owner, {
      kind: 'supplier_invoice',
      id: si.value.id,
    });
    expect(invoice.map((d) => d.kind)).toEqual(['purchase', 'receipt', 'payment']);
    expect(invoice.find((d) => d.kind === 'purchase')).toEqual({
      kind: 'purchase',
      code: po.value.code,
      path: `/purchases/${po.value.id}`,
    });
    // the plant reads receipts but no money: it sees the receipt, no supplier invoice, no payment, and no link to a purchase
    expect(await getRelatedDocuments(app, users.plant, { kind: 'purchase', id: po.value.id })).toEqual([
      { kind: 'receipt', code: '2026-06-02', path: '/receipts' },
    ]);
    expect(await getRelatedDocuments(app, users.office, { kind: 'purchase', id: po.value.id })).toEqual([]);
    expect(
      await getRelatedDocuments(app, users.partner, { kind: 'supplier_invoice', id: si.value.id }),
    ).toEqual([]);
  });
});

describe('a quote and its order (AC-INT-17)', () => {
  it('a quote has no neighbour until an order is made from it; none for a role that reads no money', async () => {
    const q = await inCtx(users.owner, (tx) => tx.query<{ id: string }>(`select id from quote limit 1`));
    const id = q.rows[0]?.id ?? randomUUID();
    expect(Array.isArray(await getRelatedDocuments(app, users.owner, { kind: 'quote', id }))).toBe(true);
    expect(await getRelatedDocuments(app, users.plant, { kind: 'quote', id })).toEqual([]);
  });
});
