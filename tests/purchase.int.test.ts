import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { cancelPurchase, createPurchase, listPurchases } from '../src/modules/ledger';
import { archiveSupplier, createSupplier } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// ledger L20: AC-LED-16 (due date), AC-LED-02 (plan = TTC, service and database), AC-LED-18 (archived supplier),
// AC-LED-03 (purchases: no delete path, cancel = reversing row), visibility (DECISIONS 81).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const marker = `pu${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-06-01';
let master: PurchaseMaster;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await purchaseMaster(app, users.owner.id, marker);
});

const input = (over: Record<string, unknown> = {}) => ({
  supplierId: master.supplierId,
  supplierInvoiceNo: 'F-2026-0042',
  supplierInvoiceDate: '2026-05-30',
  payable: 'order',
  lines: [
    {
      componentId: master.componentId,
      purchaseUnitId: master.unitId,
      qtyMilli: 30_000,
      unitPriceHtCentimes: 145_000,
    },
    { description: 'Transport', unitPriceHtCentimes: 250_000 },
  ],
  ...over,
});
const row = async (id: string) =>
  (await migrator.query(`select * from purchase where id = $1`, [id])).rows[0] ??
  (
    await inCtx(users.owner, (tx) =>
      tx.query(`select *, to_char(due_date, 'YYYY-MM-DD') as due from purchase where id = $1`, [id]),
    )
  ).rows[0];

describe('createPurchase (AC-LED-16, AC-LED-02)', () => {
  it('stores totals from the domain function, the VAT rate in force, an ACH number, a default plan on the due date', async () => {
    const r = await createPurchase(app, users.office, input(), { today: TODAY });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.code).toMatch(/^ACH-2026-\d{5}$/);
    expect(Object.keys(r.value).sort()).toEqual(['code', 'effects', 'id']); // office learns no amount
    expect(JSON.stringify(r.value)).not.toMatch(/amountCentimes|5520000/);
    const p = await row(r.value.id);
    expect(p).toMatchObject({
      vat_rate_bp: 2000,
      total_ht_centimes: '4600000',
      total_vat_centimes: '920000',
      total_ttc_centimes: '5520000',
    });
    // invoice date 2026-05-30 + 60 days
    const due = (
      await inCtx(users.owner, (tx) =>
        tx.query(`select to_char(due_date, 'YYYY-MM-DD') as d from purchase where id = $1`, [r.value.id]),
      )
    ).rows[0];
    expect(due.d).toBe('2026-07-29');
    const items = (
      await inCtx(users.owner, (tx) =>
        tx.query(`select amount_centimes::text as a, method from purchase_plan_item where purchase_id = $1`, [
          r.value.id,
        ]),
      )
    ).rows;
    expect(items).toEqual([{ a: '5520000', method: 'transfer' }]);
  });

  it('a custom plan 50/50 adds up to the total; one that does not is refused', async () => {
    const ok = await createPurchase(
      app,
      users.office,
      input({
        plan: [
          { method: 'cheque', dueDate: '2026-06-30', percentBp: 5000 },
          { method: 'cheque', dueDate: '2026-07-30', percentBp: 5000 },
        ],
      }),
      { today: TODAY },
    );
    expect(ok.ok).toBe(true);
    const bad = await createPurchase(
      app,
      users.office,
      input({ plan: [{ method: 'cheque', dueDate: '2026-06-30', amountCentimes: 100 }] }),
      { today: TODAY },
    );
    expect(bad).toEqual({ ok: false, error: 'PLAN_INVALID' });
  });

  it('a due date more than 120 days after the supplier invoice is refused, exactly 120 is accepted', async () => {
    expect(
      await createPurchase(app, users.office, input({ dueDate: '2026-09-27' }), { today: TODAY }),
    ).toMatchObject({ ok: true });
    expect(
      await createPurchase(app, users.office, input({ dueDate: '2026-09-28' }), { today: TODAY }),
    ).toEqual({
      ok: false,
      error: 'PAYMENT_TERM_TOO_LONG',
    });
  });

  it('the database refuses a plan that is not the total, and a due date beyond 120 days, even by direct SQL', async () => {
    await expect(
      inCtx(users.owner, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into purchase (id, code, supplier_id, order_date, due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values ($1, public.next_doc_number('ACH', 2026, 5), $2, '2026-06-01', '2026-07-01', 0, 100, 0, 100, $3)`,
          [id, master.supplierId, users.owner.id],
        );
        await tx.query(
          `insert into purchase_line (id, purchase_id, seq, description, qty_milli, unit_price_ht_centimes, line_ht_centimes, created_by)
           values (gen_random_uuid(), $1, 1, 'x', 1000, 100, 100, $2)`,
          [id, users.owner.id],
        );
        await tx.query(
          `insert into purchase_plan_item (id, purchase_id, seq, method, due_date, amount_centimes, created_by)
           values (gen_random_uuid(), $1, 1, 'cash', '2026-07-01', 99, $2)`,
          [id, users.owner.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into purchase (id, code, supplier_id, order_date, due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values (gen_random_uuid(), public.next_doc_number('ACH', 2026, 5), $1, '2026-06-01', '2026-10-01', 0, 100, 0, 100, $2)`,
          [master.supplierId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a line total that is not quantity times price is refused by the database', async () => {
    await expect(
      inCtx(users.owner, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into purchase (id, code, supplier_id, order_date, due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values ($1, public.next_doc_number('ACH', 2026, 5), $2, '2026-06-01', '2026-07-01', 0, 100, 0, 100, $3)`,
          [id, master.supplierId, users.owner.id],
        );
        await tx.query(
          `insert into purchase_line (id, purchase_id, seq, description, qty_milli, unit_price_ht_centimes, line_ht_centimes, created_by)
           values (gen_random_uuid(), $1, 1, 'x', 2000, 100, 100, $2)`,
          [id, users.owner.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('an archived supplier gets no new purchase, old ones still show it (AC-LED-18)', () => {
  it('refuses a new purchase for an archived supplier; the old purchase is still listed with its supplier', async () => {
    const s = await createSupplier(app, users.owner, {
      name: `Fournisseur achat ${marker}`,
      category: 'other',
    });
    if (!s.ok) throw new Error(s.error);
    const before = await createPurchase(
      app,
      users.office,
      { supplierId: s.value.id, lines: [{ description: 'Divers', unitPriceHtCentimes: 10_000 }] },
      { today: TODAY },
    );
    expect(before.ok).toBe(true);
    expect(await archiveSupplier(app, users.owner, s.value.id)).toEqual({ ok: true, value: true });
    expect(
      await createPurchase(
        app,
        users.office,
        { supplierId: s.value.id, lines: [{ description: 'Divers', unitPriceHtCentimes: 10_000 }] },
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'SUPPLIER_ARCHIVED' });
    const listed = (await listPurchases(app, users.owner)).find((p) => p.supplierId === s.value.id);
    expect(listed?.supplierName).toBe(`Fournisseur achat ${marker}`);
  });
});

describe('cancelPurchase (AC-LED-03)', () => {
  it('writes a reversing purchase and negated plan items, with the reason; the original is untouched', async () => {
    const created = await createPurchase(app, users.office, input(), { today: TODAY });
    if (!created.ok) throw new Error(created.error);
    const r = await cancelPurchase(app, users.owner, created.value.id, 'Doublon de facture', {
      today: TODAY,
    });
    if (!r.ok) throw new Error(r.error);
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query(
        `select p.total_ttc_centimes::text as ttc, p.reason, (select sum(amount_centimes)::text from purchase_plan_item where purchase_id = p.id) as plan
           from purchase p where p.id in ($1, $2) order by p.reverses_id nulls first`,
        [created.value.id, r.value.id],
      ),
    );
    expect(rows).toEqual([
      { ttc: '5520000', reason: null, plan: '5520000' },
      { ttc: '-5520000', reason: 'Doublon de facture', plan: '-5520000' },
    ]);
    expect(await cancelPurchase(app, users.owner, created.value.id, 'encore', { today: TODAY })).toEqual({
      ok: false,
      error: 'ALREADY_REVERSED',
    });
    expect(await cancelPurchase(app, users.owner, r.value.id, 'inverse', { today: TODAY })).toEqual({
      ok: false,
      error: 'CANNOT_REVERSE_REVERSAL',
    });
    const listed = await listPurchases(app, users.owner);
    expect(listed.find((p) => p.id === created.value.id)?.reversed).toBe(true);
    expect(listed.find((p) => p.id === r.value.id)).toBeUndefined();
    const audit = await migrator.query(
      `select reason from audit_event where action = 'reverse' and table_name = 'purchase' and row_id = $1`,
      [r.value.id],
    );
    expect(audit.rows[0]?.reason).toBe('Doublon de facture');
  });

  it('needs a reason, the owner, and no role can UPDATE, DELETE or TRUNCATE a purchase table', async () => {
    const created = await createPurchase(app, users.office, input(), { today: TODAY });
    if (!created.ok) throw new Error(created.error);
    expect(await cancelPurchase(app, users.owner, created.value.id, ' ', { today: TODAY })).toEqual({
      ok: false,
      error: 'REASON_REQUIRED',
    });
    await expect(
      cancelPurchase(app, users.office, created.value.id, 'oups', { today: TODAY }),
    ).rejects.toBeDefined();
    for (const table of ['purchase', 'purchase_line', 'purchase_plan_item']) {
      const { rows } = await migrator.query<{ p: string }>(
        `select privilege_type as p from information_schema.role_table_grants where grantee = 'belgobeton_app' and table_name = $1`,
        [table],
      );
      expect(rows.map((x) => x.p).sort(), table).toEqual(['INSERT', 'SELECT']);
    }
  });
});

describe('visibility (DECISIONS 81)', () => {
  it('office creates blind: it reads no purchase back; partner and plant read quantities only, never an amount', async () => {
    const created = await createPurchase(app, users.office, input(), { today: TODAY });
    if (!created.ok) throw new Error(created.error);
    for (const role of ['office', 'partner', 'plant'] as const) {
      expect((await inCtx(users[role], (tx) => tx.query('select 1 from purchase'))).rows, role).toEqual([]);
      expect(
        (await inCtx(users[role], (tx) => tx.query('select 1 from purchase_plan_item'))).rows,
        role,
      ).toEqual([]);
    }
    for (const role of ['partner', 'plant', 'owner', 'support'] as const) {
      const { rows, fields } = await inCtx(users[role], (tx) =>
        tx.query('select * from purchase_line_ops where purchase_id = $1', [created.value.id]),
      );
      expect(rows.length, role).toBe(1); // the stocked line; the transport service is not listed
      expect(rows[0]).toMatchObject({ qty_milli: '30000', unit_label: 't' });
      expectNoFields(rows, [
        'unit_price_ht_centimes',
        'line_ht_centimes',
        'total_ttc_centimes',
        'due_date',
        'supplier_invoice_no',
      ]);
      expect(fields.map((f) => f.name).sort()).toEqual(
        [
          'code',
          'component_id',
          'factor_to_base',
          'is_reversed',
          'plant_id',
          'line_id',
          'name_ar',
          'name_fr',
          'order_date',
          'purchase_id',
          'qty_milli',
          'seq',
          'supplier_code',
          'unit_label',
        ].sort(),
      );
    }
    expect((await inCtx(users.office, (tx) => tx.query('select 1 from purchase_line_ops'))).rows).toEqual([]);
    await expect(listPurchases(app, users.office)).rejects.toBeDefined();
    await expect(listPurchases(app, users.plant)).rejects.toBeDefined();
    expect(Array.isArray(await listPurchases(app, users.support))).toBe(true);
  });
});
