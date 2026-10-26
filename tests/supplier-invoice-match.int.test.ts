import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  acceptSupplierInvoiceGaps,
  approveSupplierInvoice,
  cancelPurchase,
  createPurchase,
  createSupplierInvoice,
  getSupplierInvoice,
  getSupplierInvoiceMatch,
  getSupplierStatement,
  issueInstrument,
  rejectSupplierInvoice,
} from '../src/modules/ledger';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { setParameter } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { insertPurchase, purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// integration I2.2: the three-way match, the owner's acceptance of gaps, the approval and the payable. AC-INT-14.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `sm${randomUUID().replace(/-/g, '').slice(0, 10)}`;
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

/** An order made the new way (30 t at 1 450,00, no plan of its own) for a supplier and a component of its own, received `milli` at a time. */
async function order(receipts: number[] = [30_000]) {
  const own = await inCtx(users.owner, async (tx) => {
    const supplier = await tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'cement') returning id`,
      [`sm${randomUUID().slice(0, 12)}`],
    );
    const component = await tx.query<{ id: string }>(
      `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g') returning id`,
      [`sm${randomUUID().slice(0, 12)}`],
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
  const made = await createPurchase(
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
  if (!made.ok) throw new Error(made.error);
  const { rows } = await inCtx(users.owner, (tx) =>
    tx.query<{ id: string }>(`select id from purchase_line where purchase_id = $1`, [made.value.id]),
  );
  const lineId = rows[0]?.id as string;
  for (const milli of receipts)
    await inCtx(users.owner, (tx) =>
      tx.query(`select public.record_receipt_lines($1, '2026-06-02', $2::jsonb, false)`, [
        made.value.id,
        JSON.stringify([{ lineId, qtyMilli: milli }]),
      ]),
    );
  return { ...made.value, ...own, lineId };
}
const invoice = async (
  po: { code: string; componentId: string },
  lines: object[],
  extra: object = {},
  actor: SessionUser = users.owner,
) => {
  const r = await createSupplierInvoice(
    app,
    actor,
    {
      purchaseCode: po.code,
      supplierInvoiceNo: `SM-${randomUUID().slice(0, 12)}`,
      invoiceDate: '2026-06-03',
      lines,
      ...extra,
    },
    { today: TODAY },
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const line = (po: { componentId: string }, qtyMilli = 30_000, price = 145_000) => ({
  componentId: po.componentId,
  qtyMilli,
  unitPriceHtCentimes: price,
});
const flags = async (id: string) =>
  (await getSupplierInvoiceMatch(app, users.owner, id))?.map((m) => m.flags);
const planItems = async (purchaseId: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query<{ amount: string; due: string; si: string | null }>(
        `select amount_centimes::text as amount, to_char(due_date, 'YYYY-MM-DD') as due, supplier_invoice_id as si
           from purchase_plan_item where purchase_id = $1 order by seq`,
        [purchaseId],
      ),
    )
  ).rows;

describe('the three-way match (AC-INT-14)', () => {
  it('a faithful invoice has no gap: what was ordered, received and invoiced agree', async () => {
    const po = await order();
    const si = await invoice(po, [line(po)]);
    expect(await flags(si.id)).toEqual([[]]);
    const m = (await getSupplierInvoiceMatch(app, users.owner, si.id))?.[0];
    expect(m).toMatchObject({
      orderedMilli: 30_000,
      orderedPriceCentimes: 145_000,
      receivedMilli: 30_000,
      invoicedMilli: 30_000,
      cumulativeMilli: 30_000,
      invoicedPriceCentimes: 145_000,
    });
  });

  it('flags a price above the tolerance, not one within it', async () => {
    const po = await order();
    // 1 460,00 against 1 450,00 is 0,69 %: above 0,5 %; 1 455,00 is 0,34 %: within
    expect(await flags((await invoice(po, [line(po, 30_000, 146_000)])).id)).toEqual([['PRICE']]);
    const other = await order();
    expect(await flags((await invoice(other, [line(other, 30_000, 145_500)])).id)).toEqual([[]]);
  });

  it('flags a quantity above what was received, or above what was ordered over every live invoice of the line', async () => {
    const part = await order([20_000]);
    expect(await flags((await invoice(part, [line(part, 30_000)])).id)).toEqual([['QTY_OVER_RECEIVED']]);
    // 20 100 against 20 000 is 0,5 %: within the 1 % tolerance
    const near = await order([20_000]);
    expect(await flags((await invoice(near, [line(near, 20_100)])).id)).toEqual([[]]);

    const full = await order([30_000]);
    const first = await invoice(full, [line(full, 30_000)]);
    expect(await flags(first.id)).toEqual([[]]);
    const second = await invoice(full, [line(full, 5_000)]);
    // the second invoice covers no receipt left (the first took them) and takes the line past what was ordered
    expect(await flags(second.id)).toEqual([['QTY_OVER_RECEIVED', 'QTY_OVER_ORDERED']]);
  });

  it('flags a line the order does not have', async () => {
    const po = await order();
    const si = await invoice(po, [
      line(po),
      { description: 'Transport', qtyMilli: 1000, unitPriceHtCentimes: 50_000 },
    ]);
    expect(await flags(si.id)).toEqual([[], ['NOT_ON_ORDER']]);
  });

  it('the tolerances are the parameters in force: raising one lets the same invoice through', async () => {
    const po = await order();
    const si = await invoice(po, [line(po, 30_000, 146_000)]);
    expect(await flags(si.id)).toEqual([['PRICE']]);
    await setParameter(app, users.owner, 'match_price_tolerance_bp', 100);
    try {
      expect(await flags(si.id)).toEqual([[]]);
    } finally {
      await setParameter(app, users.owner, 'match_price_tolerance_bp', 50);
    }
    expect(await flags(si.id)).toEqual([['PRICE']]);
  });
});

describe('gaps block approval until the owner accepts them (AC-INT-14)', () => {
  it('approval is refused with a gap, acceptance needs a reason and is audited, then approval goes through', async () => {
    const po = await order();
    const si = await invoice(po, [line(po, 30_000, 146_000)]);
    expect(await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.id })).toEqual({
      ok: false,
      error: 'GAPS_NOT_ACCEPTED',
    });
    expect(
      await acceptSupplierInvoiceGaps(app, users.owner, { supplierInvoiceId: si.id, reason: ' ' }),
    ).toEqual({
      ok: false,
      error: 'INVALID',
    });
    const accepted = await acceptSupplierInvoiceGaps(app, users.owner, {
      supplierInvoiceId: si.id,
      reason: 'Hausse du ciment annoncée par le fournisseur',
    });
    expect(accepted).toEqual({ ok: true, value: { accepted: true } });
    const detail = await getSupplierInvoice(app, users.owner, si.id);
    expect(detail?.invoice.state).toBe('gaps_accepted');
    expect(detail?.events.map((e) => [e.event, e.reason])).toEqual([
      ['entered', null],
      ['gaps_accepted', 'Hausse du ciment annoncée par le fournisseur'],
    ]);
    const audited = await inCtx(users.owner, (tx) =>
      tx.query(
        `select 1 from audit_event where table_name = 'supplier_invoice_event' and action = 'insert' and after::text like '%Hausse du ciment%' and actor_user_id = $1`,
        [users.owner.id],
      ),
    );
    expect(audited.rowCount).toBeGreaterThan(0);
    expect((await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.id })).ok).toBe(true);
  });

  it('there is nothing to accept on a clean invoice, nor twice', async () => {
    const po = await order();
    const clean = await invoice(po, [line(po)]);
    expect(
      await acceptSupplierInvoiceGaps(app, users.owner, { supplierInvoiceId: clean.id, reason: 'inutile' }),
    ).toEqual({
      ok: false,
      error: 'NO_GAPS',
    });
    const gap = await invoice(po, [line(po, 30_000, 150_000)]);
    expect(
      (
        await acceptSupplierInvoiceGaps(app, users.owner, {
          supplierInvoiceId: gap.id,
          reason: 'prix convenu',
        })
      ).ok,
    ).toBe(true);
    expect(
      await acceptSupplierInvoiceGaps(app, users.owner, { supplierInvoiceId: gap.id, reason: 'encore' }),
    ).toEqual({
      ok: false,
      error: 'NO_GAPS',
    });
  });

  it('rejecting frees the supplier number; an approved invoice cannot be rejected or approved again', async () => {
    const po = await order();
    const no = `SM-${randomUUID().slice(0, 12)}`;
    const first = await invoice(po, [line(po)], { supplierInvoiceNo: no });
    expect(
      (
        await rejectSupplierInvoice(app, users.owner, {
          supplierInvoiceId: first.id,
          reason: 'mauvaise facture',
        })
      ).ok,
    ).toBe(true);
    const again = await invoice(po, [line(po)], { supplierInvoiceNo: no });
    expect((await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: again.id })).ok).toBe(true);
    expect(await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: again.id })).toEqual({
      ok: false,
      error: 'NOT_PENDING',
    });
    expect(
      await rejectSupplierInvoice(app, users.owner, { supplierInvoiceId: again.id, reason: 'trop tard' }),
    ).toEqual({
      ok: false,
      error: 'NOT_PENDING',
    });
    expect(await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: first.id })).toEqual({
      ok: false,
      error: 'NOT_PENDING',
    });
  });
});

describe('the payable comes from the approved invoice, not from the order (AC-INT-14)', () => {
  it('the order has no plan of its own; approval creates the payable of the invoice, due on its due date', async () => {
    const po = await order();
    expect(await planItems(po.id)).toEqual([]);
    const si = await invoice(po, [line(po)]);
    expect(await planItems(po.id)).toEqual([]);
    const approved = await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.id });
    if (!approved.ok) throw new Error(approved.error);
    expect(approved.value.effects).toEqual([
      { kind: 'payable', supplierCode: expect.any(String), amountCentimes: 5_220_000 },
    ]);
    expect(await planItems(po.id)).toEqual([{ amount: '5220000', due: '2026-08-02', si: si.id }]);
    expect((await getSupplierInvoice(app, users.owner, si.id))?.invoice.state).toBe('approved');
  });

  it('a plan of several payments must add up to the invoice total and respect the 120 days', async () => {
    const po = await order();
    const si = await invoice(po, [line(po)]);
    const plan = (items: object[]) =>
      approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.id, plan: items });
    expect((await plan([{ method: 'cheque', dueDate: '2026-07-03', amountCentimes: 1_000_000 }])).ok).toBe(
      false,
    );
    expect((await plan([{ method: 'cheque', dueDate: '2027-01-01', amountCentimes: 5_220_000 }])).ok).toBe(
      false,
    );
    expect(
      (
        await plan([
          { method: 'cheque', dueDate: '2026-07-03', amountCentimes: 2_610_000 },
          { method: 'cheque', dueDate: '2026-08-03', amountCentimes: 2_610_000 },
        ])
      ).ok,
    ).toBe(true);
    expect((await planItems(po.id)).map((i) => i.amount)).toEqual(['2610000', '2610000']);
  });

  it('two invoices of one order each give their own payable, the plan of the order numbering on', async () => {
    const po = await order([20_000]);
    const a = await invoice(po, [line(po, 20_000)]);
    await inCtx(users.owner, (tx) =>
      tx.query(`select public.record_receipt_lines($1, '2026-06-05', $2::jsonb, false)`, [
        po.id,
        JSON.stringify([{ lineId: po.lineId, qtyMilli: 10_000 }]),
      ]),
    );
    const b = await invoice(po, [line(po, 10_000)]);
    expect(await flags(a.id)).toEqual([[]]);
    expect(await flags(b.id)).toEqual([[]]);
    expect((await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: a.id })).ok).toBe(true);
    expect((await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: b.id })).ok).toBe(true);
    expect((await planItems(po.id)).map((i) => [i.amount, i.si])).toEqual([
      ['3480000', a.id],
      ['1740000', b.id],
    ]);
  });

  it('an order that carries its own payable (made before) cannot be approved through an invoice', async () => {
    const legacy = await inCtx(users.owner, async (tx) => {
      const po = await insertPurchase(tx, users.owner.id, master);
      await tx.query(`select public.record_receipt($1, '2026-06-02')`, [po.id]);
      return po;
    });
    const si = await createSupplierInvoice(
      app,
      users.owner,
      {
        purchaseCode: legacy.code,
        supplierInvoiceNo: `SM-${randomUUID().slice(0, 12)}`,
        invoiceDate: '2026-06-03',
        lines: [{ componentId: master.componentId, qtyMilli: 30_000, unitPriceHtCentimes: 145_000 }],
      },
      { today: TODAY },
    );
    if (!si.ok) throw new Error(si.error);
    expect(await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.value.id })).toEqual({
      ok: false,
      error: 'REFUSED',
    });
  });

  it('the supplier statement carries the approved invoice as what is owed; the order itself is not a debt; a payment by invoice code covers it', async () => {
    const po = await order();
    const si = await invoice(po, [line(po)]);
    const statement = async () => {
      const s = await getSupplierStatement(app, users.owner, po.supplierId, {}, { today: TODAY });
      if (!s) throw new Error('no statement');
      return s.statement;
    };
    expect(Number((await statement()).closing)).toBe(0);
    expect((await approveSupplierInvoice(app, users.owner, { supplierInvoiceId: si.id })).ok).toBe(true);
    const after = await statement();
    expect(Number(after.closing)).toBe(5_220_000);
    expect(after.commercial.find((l) => l.type === 'supplier_invoice')).toMatchObject({
      code: si.code,
      counted: true,
    });
    expect(after.commercial.find((l) => l.type === 'purchase')).toMatchObject({
      code: po.code,
      counted: false,
    });
    const paid = await issueInstrument(
      app,
      users.owner,
      { supplierId: po.supplierId, method: 'transfer', amountCentimes: 5_220_000, purchaseCode: si.code },
      { today: TODAY },
    );
    expect(paid.ok).toBe(true);
    const covered = await inCtx(users.owner, (tx) =>
      tx.query<{ s: string }>(
        `select coalesce(sum(a.amount_centimes), 0)::text as s from allocation a join purchase_plan_item i on i.id = a.purchase_plan_item_id where i.supplier_invoice_id = $1`,
        [si.id],
      ),
    );
    expect(covered.rows[0]?.s).toBe('5220000');
    expect(Number((await statement()).closing)).toBe(0);
  });

  it('an order cannot be cancelled while an invoice stands on it; once rejected it can', async () => {
    const po = await order();
    const si = await invoice(po, [line(po)]);
    const cancel = () => cancelPurchase(app, users.owner, po.id, 'annulation', { today: TODAY });
    expect((await cancel()).ok).toBe(false);
    expect(
      (await rejectSupplierInvoice(app, users.owner, { supplierInvoiceId: si.id, reason: 'erreur' })).ok,
    ).toBe(true);
    expect((await cancel()).ok).toBe(true);
  });
});

describe('who decides (AC-INT-14)', () => {
  it('only the owner accepts, approves and rejects; the database says so too', async () => {
    const po = await order();
    const si = await invoice(po, [line(po, 30_000, 150_000)]);
    for (const role of ['office', 'partner', 'plant', 'support'] as const) {
      await expect(
        approveSupplierInvoice(app, users[role], { supplierInvoiceId: si.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        acceptSupplierInvoiceGaps(app, users[role], { supplierInvoiceId: si.id, reason: 'essai' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        rejectSupplierInvoice(app, users[role], { supplierInvoiceId: si.id, reason: 'essai' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      for (const sql of [
        'select public.approve_supplier_invoice($1, null)',
        "select public.accept_supplier_invoice_gaps($1, 'essai')",
        "select public.reject_supplier_invoice($1, 'essai')",
      ])
        await expect(inCtx(users[role], (tx) => tx.query(sql, [si.id]))).rejects.toMatchObject({
          code: '42501',
        });
    }
    for (const role of ['office', 'partner', 'plant'] as const)
      await expect(
        inCtx(users[role], (tx) => tx.query('select * from public.supplier_invoice_match($1)', [si.id])),
      ).rejects.toMatchObject({
        code: '42501',
      });
    await expect(getSupplierInvoiceMatch(app, users.support, si.id)).resolves.toBeDefined();
  });
});
