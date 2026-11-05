import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  buildAccountingExport,
  cancelInvoice,
  createInvoice,
  createPurchase,
  exportFilesFor,
  getInvoiceDocument,
  listInvoices,
} from '../src/modules/ledger';
import { createLoad, markDelivered } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { deliveryScene, type DeliveryScene, purchaseMaster } from './helpers/ledger-fixtures';

// ledger L32: AC-LED-24 (the export reconciles with the invoices and is refused when it does not), AC-LED-21 (owner and
// support only). The files carry only names and codes as text and no cell a spreadsheet could take for a formula.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support' | 'accountant', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const marker = `ae${randomUUID().replace(/-/g, '').slice(0, 10)}`;
// A year no other test uses, so the period holds exactly what this file made.
const DAY = '2088-03-10';
let scene: DeliveryScene;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support', 'accountant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});

describe('the accountant export (AC-LED-24)', () => {
  it('has the invoices, the credit note, the purchases and the ageing, and reconciles with the stored invoices', async () => {
    const code = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ code: string }>('select code from sales_order where id = $1', [scene.orderId]),
      )
    ).rows[0]?.code as string;
    const load = await createLoad(
      app,
      users.plant,
      { orderId: scene.orderId, truckId: scene.truckId, volumeL: 4000 },
      { today: '2026-06-10' },
    );
    if (!load.ok) throw new Error(load.error);
    // Only a delivered load is billed (D97).
    await markDelivered(
      app,
      users.plant,
      { deliveryId: load.value.id },
      { now: new Date('2026-06-10T10:00:00Z') },
    );
    const inv = await createInvoice(app, users.owner, { orderCode: code }, { today: DAY });
    if (!inv.ok) throw new Error(inv.error);
    const master = await purchaseMaster(app, users.owner.id, marker);
    const purchase = await createPurchase(
      app,
      users.office,
      {
        supplierId: master.supplierId,
        supplierInvoiceNo: 'F-AE-1',
        payable: 'order',
        lines: [{ description: 'Transport (test)', qtyMilli: 1000, unitPriceHtCentimes: 250_000 }],
      },
      { today: DAY },
    );
    if (!purchase.ok) throw new Error(purchase.error);
    const credit = await cancelInvoice(app, users.owner, inv.value.id, 'Erreur (test)', {
      today: '2088-03-12',
    });
    if (!credit.ok) throw new Error(credit.error);

    const out = await buildAccountingExport(app, users.owner, { from: '2088-03-01', to: '2088-03-31' });
    if (!out.ok) throw new Error(out.error);
    expect(out.value.summary).toMatchObject({
      invoices: 2,
      purchases: 1,
      salesTtcCentimes: 0,
      purchasesTtcCentimes: 300_000,
    });
    const sales = out.value.files.sales;
    expect(sales).toContain(`${inv.value.number};${DAY};dl${marker};`);
    expect(sales).toContain('3120,00;624,00;3744,00');
    expect(sales).toContain(`-3744,00;${inv.value.number}`);
    expect(out.value.files.purchases).toContain('F-AE-1');
    expect(out.value.files.purchases).toContain('2500,00;500,00;3000,00');
    expect(out.value.files.ageing).toContain('Dettes fournisseurs');
    expect(out.value.files.ageing).toContain('ACH-');
    expect(out.value.files.payments.startsWith('﻿Règlements')).toBe(true);
    // The sales journal equals the invoice lines it came from.
    const lines = await migrator.query<{ s: string }>(
      `select sum(l.line_ht_centimes)::text as s from invoice_line l join invoice i on i.id = l.invoice_id where i.invoice_date between '2088-03-01' and '2088-03-31'`,
    );
    expect(lines.rows[0]?.s).toBe('0');
  });

  it('is refused for office, partner and plant; support may read; an invalid period is refused', async () => {
    for (const role of ['office', 'partner', 'plant'] as const)
      await expect(
        buildAccountingExport(app, users[role], { from: '2088-03-01', to: '2088-03-31' }),
      ).rejects.toBeDefined();
    expect(
      (await buildAccountingExport(app, users.support, { from: '2088-03-01', to: '2088-03-31' })).ok,
    ).toBe(true);
    expect(await buildAccountingExport(app, users.owner, { from: '2088-03-31', to: '2088-03-01' })).toEqual({
      ok: false,
      error: 'INVALID_PERIOD',
    });
    expect(await buildAccountingExport(app, users.owner, { from: 'x', to: '2088-03-01' })).toEqual({
      ok: false,
      error: 'INVALID_PERIOD',
    });
  });

  it('an empty period is an empty but valid export', async () => {
    const out = await buildAccountingExport(app, users.owner, { from: '2088-06-01', to: '2088-06-30' });
    if (!out.ok) throw new Error(out.error);
    expect(out.value.summary).toMatchObject({ invoices: 0, purchases: 0 });
    expect(out.value.files.sales).toContain('Total;;;;0,00;0,00;0,00;');
  });
});

// F09: the accountant's invoice and export paths never call the payment-state door (which refuses the role) and carry no balance.
describe('the accountant paths (F09)', () => {
  const period = { from: '2088-03-01', to: '2088-03-31' };
  it('reads the invoices with their amounts and no payment standing', async () => {
    const list = await listInvoices(app, users.accountant);
    const mine = list.filter((i) => i.invoiceDate >= period.from && i.invoiceDate <= period.to);
    expect(mine.length).toBeGreaterThan(0);
    for (const i of mine) {
      expect(i.paymentState).toBeNull();
      expect(i.paidCentimes).toBe(0);
    }
    const doc = await getInvoiceDocument(app, users.accountant, mine[0]!.id);
    expect(doc?.invoice.number).toBe(mine[0]!.number);
    expect(doc?.invoice.paymentState).toBeNull();
    // the owner still gets the standing from the same list
    const ownerView = (await listInvoices(app, users.owner)).find((i) => i.id === mine[0]!.id);
    expect(ownerView).toBeDefined();
  });
  it('exports the sales journal and nothing that is a balance, a treasury figure or a table the role cannot read', async () => {
    const out = await buildAccountingExport(app, users.accountant, period);
    if (!out.ok) throw new Error(out.error);
    expect(out.value.summary).toMatchObject({ invoices: 2, purchases: 0, payments: 0, movements: 0 });
    expect(out.value.files.sales).toContain('FA-');
    expect(out.value.files.purchases).toBe('');
    expect(out.value.files.payments).toBe('');
    expect(out.value.files.ageing).toBe('');
    expect(exportFilesFor('accountant')).toEqual(['sales']);
    expect(exportFilesFor('owner')).toEqual(['sales', 'purchases', 'payments', 'ageing']);
    expect(exportFilesFor('support')).toHaveLength(4);
  });
  it('the database still refuses the accountant the payment-state door (the fix widens nothing)', async () => {
    await expect(
      inCtx(users.accountant, (tx) => tx.query('select * from public.invoice_payment_state()')),
    ).rejects.toThrow(/may not read payment states/);
  });
});
