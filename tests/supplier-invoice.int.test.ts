import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createSupplierInvoice, getSupplierInvoice, listSupplierInvoices } from '../src/modules/ledger';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { insertPurchase, type PurchaseMaster, purchaseMaster } from './helpers/ledger-fixtures';

// integration I2.1: the supplier's invoice is its own document, linked to one order and to its receipts. AC-INT-13.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `si${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-06-10';
let master: PurchaseMaster;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await purchaseMaster(app, users.owner.id, marker);
});

/** A purchase of 30 t (a supplier and a component of its own) with its line ids; `received` litres of milli-tonnes per receipt. */
async function purchase(receipts: number[] = []) {
  return inCtx(users.owner, async (tx) => {
    const supplier = await tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
      [`si${randomUUID().slice(0, 12)}`],
    );
    const component = await tx.query<{ id: string }>(
      `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g') returning id`,
      [`si${randomUUID().slice(0, 12)}`],
    );
    const unit = await tx.query<{ id: string }>(
      `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 'kg', 1000) returning id`,
      [component.rows[0]?.id],
    );
    const own = {
      ...master,
      supplierId: supplier.rows[0]?.id as string,
      componentId: component.rows[0]?.id as string,
      unitId: unit.rows[0]?.id as string,
    };
    const po = await insertPurchase(tx, users.owner.id, own);
    const line = await tx.query<{ id: string }>(`select id from purchase_line where purchase_id = $1`, [
      po.id,
    ]);
    const received: string[] = [];
    for (const milli of receipts) {
      const r = await tx.query<{ id: string }>(
        `select public.record_receipt_lines($1, '2026-06-02', $2::jsonb, false) as id`,
        [po.id, JSON.stringify([{ lineId: line.rows[0]?.id, qtyMilli: milli }])],
      );
      received.push(r.rows[0]?.id as string);
    }
    return { ...po, componentId: own.componentId, lineId: line.rows[0]?.id as string, receiptIds: received };
  });
}
const enter = (
  actor: SessionUser,
  po: { code: string; componentId: string },
  patch: object = {},
  no = `FS-${randomUUID().slice(0, 12)}`,
) =>
  createSupplierInvoice(
    app,
    actor,
    {
      purchaseCode: po.code,
      supplierInvoiceNo: no,
      invoiceDate: '2026-06-03',
      lines: [{ componentId: po.componentId, qtyMilli: 30_000, unitPriceHtCentimes: 145_000 }],
      ...patch,
    },
    { today: TODAY },
  );

describe('entering a supplier invoice (AC-INT-13)', () => {
  it('links the invoice to its order and its receipts, links each line to the order line, and computes the totals', async () => {
    const po = await purchase([10_000, 20_000]);
    const made = await enter(users.owner, po);
    if (!made.ok) throw new Error(made.error);
    expect(made.value.code).toMatch(/^FF-2026-\d{5}$/);
    const detail = await getSupplierInvoice(app, users.owner, made.value.id);
    expect(detail?.invoice).toMatchObject({
      purchaseCode: po.code,
      totalHtCentimes: 4_350_000,
      totalVatCentimes: 870_000,
      totalTtcCentimes: 5_220_000,
      dueDate: '2026-08-02',
      state: 'entered',
      receiptCount: 2,
    });
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0]).toMatchObject({
      purchaseLineSeq: 1,
      qtyMilli: 30_000,
      unitPriceHtCentimes: 145_000,
      lineHtCentimes: 4_350_000,
    });
    expect(detail?.receipts.map((r) => r.id).sort()).toEqual([...po.receiptIds].sort());
    expect(detail?.events.map((e) => e.event)).toEqual(['entered']);
  });

  it('an invoice for part of the order covers the receipts not covered yet: the next one takes the rest', async () => {
    const po = await purchase([10_000]);
    const first = await enter(users.owner, po, {
      lines: [{ componentId: po.componentId, qtyMilli: 10_000, unitPriceHtCentimes: 145_000 }],
    });
    if (!first.ok) throw new Error(first.error);
    const second = await inCtx(
      users.owner,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `select public.record_receipt_lines($1, '2026-06-05', $2::jsonb, false) as id`,
            [po.id, JSON.stringify([{ lineId: po.lineId, qtyMilli: 20_000 }])],
          )
        ).rows[0]?.id,
    );
    const next = await enter(users.owner, po, {
      lines: [{ componentId: po.componentId, qtyMilli: 20_000, unitPriceHtCentimes: 145_000 }],
    });
    if (!next.ok) throw new Error(next.error);
    const a = await getSupplierInvoice(app, users.owner, first.value.id);
    const b = await getSupplierInvoice(app, users.owner, next.value.id);
    expect(a?.receipts.map((r) => r.id)).toEqual([po.receiptIds[0]]);
    expect(b?.receipts.map((r) => r.id)).toEqual([second]);
  });

  it('a line with no component, or a component the order does not have, is not linked to an order line', async () => {
    const po = await purchase([30_000]);
    const made = await enter(users.owner, po, {
      lines: [
        { componentId: po.componentId, qtyMilli: 30_000, unitPriceHtCentimes: 145_000 },
        { description: 'Transport', qtyMilli: 1000, unitPriceHtCentimes: 50_000 },
        { componentId: po.componentId, qtyMilli: 1000, unitPriceHtCentimes: 145_000 },
      ],
    });
    if (!made.ok) throw new Error(made.error);
    const detail = await getSupplierInvoice(app, users.owner, made.value.id);
    expect(detail?.lines.map((l) => l.purchaseLineSeq)).toEqual([1, null, null]);
  });

  it("the supplier's own number is entered once per supplier; another order of the same supplier cannot reuse it", async () => {
    const po = await purchase([30_000]);
    const no = `FS-${randomUUID().slice(0, 12)}`;
    expect((await enter(users.owner, po, {}, no)).ok).toBe(true);
    expect(await enter(users.owner, po, {}, no)).toEqual({ ok: false, error: 'REFUSED' });
    expect(await enter(users.owner, po, {}, no.toLowerCase())).toEqual({ ok: false, error: 'REFUSED' });
    expect((await enter(users.owner, po, {}, `${no}-B`)).ok).toBe(true);
  });

  it('refuses an unknown order, a date in the future, a due date too far or before the invoice, with one audited answer', async () => {
    const po = await purchase();
    expect(await enter(users.owner, { code: 'ACH-2026-99999', componentId: po.componentId })).toEqual({
      ok: false,
      error: 'REFUSED',
    });
    expect(await enter(users.owner, po, { invoiceDate: '2026-07-01' })).toEqual({
      ok: false,
      error: 'REFUSED',
    });
    expect(await enter(users.owner, po, { dueDate: '2026-12-31' })).toEqual({
      ok: false,
      error: 'PAYMENT_TERM_TOO_LONG',
    });
    expect(await enter(users.owner, po, { dueDate: '2026-06-01' })).toEqual({
      ok: false,
      error: 'DUE_BEFORE_INVOICE',
    });
    expect(await enter(users.owner, po, { lines: [] })).toEqual({ ok: false, error: 'INVALID' });
    const audited = await inCtx(users.owner, (tx) =>
      tx.query(
        `select 1 from audit_event where table_name = 'supplier_invoice_create' and action = 'permission_denied' and actor_user_id = $1`,
        [users.owner.id],
      ),
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });

  it('a receipt that is not of the order is refused and nothing is kept', async () => {
    const po = await purchase([30_000]);
    const other = await purchase([30_000]);
    const before = (await listSupplierInvoices(app, users.owner)).length;
    await expect(enter(users.owner, po, { receiptIds: [other.receiptIds[0]] })).resolves.toMatchObject({
      ok: false,
    });
    expect((await listSupplierInvoices(app, users.owner)).length).toBe(before);
  });
});

describe('who sees what (AC-INT-13)', () => {
  it('office enters blind: our code and no amount, no id; it cannot read the list', async () => {
    const po = await purchase([30_000]);
    const made = await enter(users.office, po);
    if (!made.ok) throw new Error(made.error);
    expect(made.value.code).toMatch(/^FF-/);
    expect(made.value.id).toBe('');
    expectNoFields(made.value, ['amountCentimes', 'totalTtcCentimes', 'unitPrice']);
    expect(JSON.stringify(made.value)).not.toMatch(/4350000|5220000|145000/);
    await expect(listSupplierInvoices(app, users.office)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users.office, (tx) => tx.query('select 1 from supplier_invoice')),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('partner and plant cannot enter or read; support reads and cannot enter', async () => {
    const po = await purchase();
    for (const role of ['partner', 'plant', 'support'] as const)
      await expect(enter(users[role], po)).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ['partner', 'plant'] as const)
      await expect(listSupplierInvoices(app, users[role])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSupplierInvoices(app, users.support)).resolves.toBeDefined();
  });

  it('the database refuses a direct row to every role, and the function to partner, plant and support', async () => {
    const po = await purchase();
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into supplier_invoice (id, code, purchase_id, supplier_id, supplier_invoice_no, invoice_date, due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           select gen_random_uuid(), 'FF-2026-99999', p.id, p.supplier_id, 'x', '2026-06-01', '2026-07-01', 2000, 100, 20, 120, $2 from purchase p where p.code = $1`,
          [po.code, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    for (const role of ['partner', 'plant', 'support'] as const)
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `select public.create_supplier_invoice($1, 'x', '2026-06-01', null, '[]'::jsonb, null, '2026-06-10')`,
            [po.code],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
  });
});
