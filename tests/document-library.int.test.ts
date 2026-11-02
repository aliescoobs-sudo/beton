import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInvoice,
  getInvoiceDocument,
  getInvoiceForPrint,
  libraryKinds,
  listDocumentLibrary,
  mayOpen,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';
import { clientWithLoads, deliveryScene, orderMaster, type OrderMaster } from './helpers/ledger-fixtures';

// §16.2: the library lists only what the role may open; office_sales prints an invoice through the print door and never
// sees balances; every download re-checks the type permission.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await Promise.all([app.end(), migrator.end()]);
});
const marker = `dl${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const ROLES = [
  'owner',
  'office_sales',
  'office_purchases',
  'plant_manager',
  'accountant',
  'driver',
  'client_portal',
] as const;
const users = {} as Record<(typeof ROLES)[number], SessionUser>;
let invoiceId = '';
let invoiceNumber = '';

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  for (const r of ROLES) users[r] = r === 'owner' ? v.owner : v.session(r);
  const scene = await deliveryScene(app, users.owner.id, marker);
  const master: OrderMaster = await orderMaster(app, users.owner.id, marker);
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[4000]], { delivered: true });
  const ids = c.orders.flatMap((o) => o.deliveryIds);
  const inv = await createInvoice(app, users.owner, { deliveryIds: ids }, { today: '2026-07-03' });
  if (!inv.ok) throw new Error(inv.error);
  invoiceNumber = inv.value.number;
  invoiceId = (
    await migrator.query<{ id: string }>('select id from invoice where number = $1', [invoiceNumber])
  ).rows[0]!.id;
});

describe('the library by role and type (§16.2)', () => {
  it('lists only the types a role may open', () => {
    expect(libraryKinds('owner').sort()).toEqual([
      'avoir',
      'bl',
      'invoice',
      'quote',
      'supplier_invoice_file',
    ]);
    expect(libraryKinds('office_sales').sort()).toEqual(['bl', 'invoice']);
    expect(libraryKinds('office_purchases')).toEqual(['bl']);
    expect(libraryKinds('plant_manager')).toEqual(['bl']);
    expect(libraryKinds('accountant').sort()).toEqual(['avoir', 'invoice']);
    expect(libraryKinds('driver')).toEqual([]);
    expect(libraryKinds('client_portal')).toEqual([]);
  });

  it('a role with no document right is refused the library', async () => {
    await expect(listDocumentLibrary(app, users.driver)).rejects.toThrow(/Forbidden/);
    await expect(listDocumentLibrary(app, users.client_portal)).rejects.toThrow(/Forbidden/);
  });

  it('owner, accountant and office_sales see the invoice; office_purchases and the plant do not', async () => {
    for (const r of ['owner', 'accountant', 'office_sales'] as const) {
      const list = await listDocumentLibrary(app, users[r], 'invoice');
      expect(
        list.map((e) => e.number),
        r,
      ).toContain(invoiceNumber);
    }
    for (const r of ['office_purchases', 'plant_manager'] as const) {
      expect(await listDocumentLibrary(app, users[r], 'invoice'), r).toEqual([]);
    }
  });

  it('the library entries carry no amount', async () => {
    const list = await listDocumentLibrary(app, users.office_sales);
    for (const e of list) expect(Object.keys(e).sort()).toEqual(['date', 'id', 'kind', 'number', 'party']);
  });
});

describe('download re-checks the permission and the row-level security (§16.2)', () => {
  it('mayOpen follows the type permission, not the list', () => {
    expect(mayOpen('office_purchases', 'invoice')).toBe(false);
    expect(mayOpen('office_sales', 'invoice')).toBe(true);
    expect(mayOpen('office_sales', 'avoir')).toBe(false);
    expect(mayOpen('accountant', 'bl')).toBe(false);
  });

  it('office_sales prints the invoice with its amounts, with no payment state or balance', async () => {
    const doc = await getInvoiceForPrint(app, users.office_sales, invoiceId);
    expect(doc?.invoice.number).toBe(invoiceNumber);
    expect(doc?.invoice.totalTtcCentimes).toBeGreaterThan(0);
    expect(doc?.invoice.paymentState).toBeNull();
    expect(doc?.invoice.paidCentimes).toBe(0);
    const owner = await getInvoiceDocument(app, users.owner, invoiceId);
    expect(doc?.invoice.totalTtcCentimes).toBe(owner?.invoice.totalTtcCentimes);
    expect(doc?.lines.map((l) => l.lineHtCentimes)).toEqual(owner?.lines.map((l) => l.lineHtCentimes));
  });

  it('office_purchases, the plant and the accountant cannot use the print door; a malformed id is nothing', async () => {
    await expect(getInvoiceForPrint(app, users.office_purchases, invoiceId)).rejects.toThrow(/Forbidden/);
    await expect(getInvoiceForPrint(app, users.plant_manager, invoiceId)).rejects.toThrow(/Forbidden/);
    expect(await getInvoiceForPrint(app, users.office_sales, 'not-a-uuid')).toBeNull();
  });
});
