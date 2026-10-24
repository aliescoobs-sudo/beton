import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelInvoice,
  createInvoice,
  getClientStatement,
  legalDeadlines,
  listInvoices,
} from '../src/modules/ledger';
import { createLoad } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene, insertOrder, orderMaster } from './helpers/ledger-fixtures';

// ledger L17 (+ the credit note of L18): AC-LED-08 (gapless numbers under concurrency, a credit note keeps the number),
// AC-LED-09 (due date), AC-LED-15 (issue deadline), AC-LED-03 (invoices), visibility (DECISIONS 81).
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 12 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const marker = `inv${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const LOAD_DAY = '2026-06-10';
const TODAY = '2026-07-03';
let scene: DeliveryScene;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
});

/** A fresh order of 100 m³ (own client) with `loads` loads of the given litres; returns the order and the load ids. */
async function orderWithLoads(volumesL: number[]) {
  const ice = String(Math.floor(Math.random() * 1e15)).padStart(15, '0');
  const master = await orderMaster(app, users.owner.id, marker);
  const order = await inCtx(users.owner, async (tx) => {
    const client = await tx.query<{ id: string }>(
      `insert into client (id, code, name, kind, ice) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'company', $2) returning id`,
      [`inv ${randomUUID()}`, ice],
    );
    return insertOrder(tx, users.owner.id, { ...master, clientId: client.rows[0]?.id as string });
  });
  const ids: string[] = [];
  for (const volumeL of volumesL) {
    const l = await createLoad(
      app,
      users.plant,
      { orderId: order.id, truckId: scene.truckId, volumeL },
      { today: LOAD_DAY },
    );
    if (!l.ok) throw new Error(l.error);
    ids.push(l.value.id);
  }
  return { order, ids, ice };
}
const row = async (id: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query(
        `select number, client_name, client_ice, vat_rate_bp, total_ht_centimes::text as ht, total_vat_centimes::text as vat,
                total_ttc_centimes::text as ttc, to_char(issue_deadline, 'YYYY-MM-DD') as deadline, to_char(due_date, 'YYYY-MM-DD') as due
           from invoice where id = $1`,
        [id],
      ),
    )
  ).rows[0];

describe('createInvoice (AC-LED-08, 09, 15)', () => {
  it('invoices the loads of an order: lines at the order price, name and ICE and VAT copied, deadline at month end, due +60', async () => {
    const { order, ice } = await orderWithLoads([6000, 4000]);
    const r = await createInvoice(app, users.office, { orderCode: order.code }, { today: TODAY });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.number).toMatch(/^FA-2026-\d{5}$/);
    expect(Object.keys(r.value).sort()).toEqual(['effects', 'id', 'number']);
    expect(JSON.stringify(r.value)).not.toMatch(/amountCentimes|936000/); // office learns no amount
    expect(await row(r.value.id)).toMatchObject({
      client_ice: ice,
      vat_rate_bp: 2000,
      ht: '780000',
      vat: '156000',
      ttc: '936000',
      deadline: '2026-06-30',
      due: '2026-09-01',
    });
    const lines = await inCtx(users.owner, (tx) =>
      tx.query(
        `select description, volume_l, line_ht_centimes::text as ht from invoice_line where invoice_id = $1 order by seq`,
        [r.value.id],
      ),
    );
    expect(lines.rows).toHaveLength(2);
    expect(lines.rows.map((l) => [l.volume_l, l.ht])).toEqual([
      [6000, '468000'],
      [4000, '312000'],
    ]);
    expect(lines.rows[0].description).toMatch(/^Béton .* — BL BL-\d{4}-\d{5} du 2026-06-10$/);
  });

  it('a load is invoiced once: a second invoice of the same order finds nothing; a chosen load can be invoiced alone', async () => {
    const { order, ids } = await orderWithLoads([3000, 2000]);
    const first = await createInvoice(
      app,
      users.owner,
      { orderCode: order.code, deliveryIds: [ids[0]] },
      { today: TODAY },
    );
    expect(first.ok).toBe(true);
    const second = await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY });
    expect(second.ok).toBe(true); // the other load
    expect(await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY })).toEqual({
      ok: false,
      error: 'NOTHING_TO_INVOICE',
    });
    expect(
      await createInvoice(
        app,
        users.owner,
        { orderCode: order.code, deliveryIds: [randomUUID()] },
        { today: TODAY },
      ),
    ).toMatchObject({ ok: false });
  });

  it('due date: default +60, 120 accepted, 121 refused (AC-LED-09)', async () => {
    const { order } = await orderWithLoads([1000, 1000, 1000]);
    expect(
      await createInvoice(
        app,
        users.owner,
        { orderCode: order.code, dueDate: '2026-11-01', deliveryIds: undefined },
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'PAYMENT_TERM_TOO_LONG' });
    // 2026-07-03 + 120 days = 2026-10-31
    const ok = await createInvoice(
      app,
      users.owner,
      { orderCode: order.code, dueDate: '2026-10-31' },
      { today: TODAY },
    );
    expect(ok.ok).toBe(true);
  });

  it('10 parallel creations give 10 distinct, consecutive numbers (AC-LED-08)', async () => {
    const made = await Promise.all(Array.from({ length: 10 }, () => orderWithLoads([500])));
    const results = await Promise.all(
      made.map((m, i) =>
        createInvoice(app, i % 2 ? users.office : users.owner, { orderCode: m.order.code }, { today: TODAY }),
      ),
    );
    const numbers = results.map((r) => {
      if (!r.ok) throw new Error(r.error);
      return Number(r.value.number.slice(-5));
    });
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(10);
    expect(sorted.at(-1)! - sorted[0]!).toBe(9);
  });

  it('a rolled-back creation gives its number back (gapless)', async () => {
    const { order } = await orderWithLoads([700]);
    const before = await inCtx(users.owner, (tx) =>
      tx.query<{ n: string }>(
        `select last_value::text as n from doc_sequence where prefix = 'FA' and year = 2026`,
      ),
    );
    await expect(
      inCtx(users.owner, async (tx) => {
        await tx.query(`select public.next_doc_number('FA', 2026, 5)`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await inCtx(users.owner, (tx) =>
      tx.query<{ n: string }>(
        `select last_value::text as n from doc_sequence where prefix = 'FA' and year = 2026`,
      ),
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const r = await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY });
    if (!r.ok) throw new Error(r.error);
    expect(Number(r.value.number.slice(-5))).toBe(Number(before.rows[0]?.n) + 1);
  });

  it('the database refuses a wrong VAT, a wrong line total and a load invoiced twice, even by direct SQL', async () => {
    const { order, ids } = await orderWithLoads([1000, 1000]);
    const insert = (vat: number, lineHt: number, delivery: string) =>
      inCtx(users.owner, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into invoice (id, number, order_id, client_id, client_name, invoice_date, issue_deadline, due_date, vat_rate_bp,
                                total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           select $1, public.next_doc_number('FA', 2026, 5), o.id, o.client_id, 'x', '2026-07-03', '2026-06-30', '2026-08-01', 2000,
                  78000, $2::bigint, 78000 + $2::bigint, $3 from sales_order o where o.id = $4`,
          [id, vat, users.owner.id, order.id],
        );
        await tx.query(
          `insert into invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes, line_ht_centimes, created_by)
           values (gen_random_uuid(), $1, 1, $2, 'x', 1000, 78000, $3, $4)`,
          [id, delivery, lineHt, users.owner.id],
        );
      });
    await expect(insert(1, 78000, ids[0]!)).rejects.toMatchObject({ code: '23514' }); // VAT is 15 600
    await expect(insert(15_600, 77_999, ids[0]!)).rejects.toMatchObject({ code: '23514' }); // line total
    const good = await createInvoice(
      app,
      users.owner,
      { orderCode: order.code, deliveryIds: [ids[0]!] },
      { today: TODAY },
    );
    expect(good.ok).toBe(true);
    await expect(insert(15_600, 78_000, ids[0]!)).rejects.toMatchObject({ code: '23514' }); // already invoiced
    await expect(insert(15_600, 78_000, ids[1]!)).resolves.toBeUndefined();
  });
});

describe('cancelInvoice: the credit note (AC-LED-08, AC-LED-03)', () => {
  it('writes a credit note with its own number and negated lines; the invoice keeps its number and its loads can be invoiced again', async () => {
    const { order } = await orderWithLoads([5000]);
    const inv = await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY });
    if (!inv.ok) throw new Error(inv.error);
    const cn = await cancelInvoice(app, users.owner, inv.value.id, 'Erreur de prix', { today: TODAY });
    if (!cn.ok) throw new Error(cn.error);
    expect(cn.value.number).not.toBe(inv.value.number);
    expect(await row(cn.value.id)).toMatchObject({ ttc: `-${(await row(inv.value.id)).ttc}` });
    expect((await row(inv.value.id)).number).toBe(inv.value.number);
    const sums = await inCtx(users.owner, (tx) =>
      tx.query(`select sum(line_ht_centimes)::text as s from invoice_line where invoice_id in ($1, $2)`, [
        inv.value.id,
        cn.value.id,
      ]),
    );
    expect(sums.rows[0]?.s).toBe('0');
    expect(await cancelInvoice(app, users.owner, inv.value.id, 'encore', { today: TODAY })).toEqual({
      ok: false,
      error: 'ALREADY_CREDITED',
    });
    expect(await cancelInvoice(app, users.owner, cn.value.id, 'inverse', { today: TODAY })).toEqual({
      ok: false,
      error: 'CANNOT_CREDIT_CREDIT_NOTE',
    });
    const listed = await listInvoices(app, users.owner);
    expect(listed.find((i) => i.id === inv.value.id)?.cancelled).toBe(true);
    expect(listed.find((i) => i.id === cn.value.id)).toMatchObject({
      creditNoteOf: inv.value.id,
      reason: 'Erreur de prix',
    });
    // the load is free again
    expect((await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY })).ok).toBe(
      true,
    );
    const audit = await app.query(`select 1`); // pool alive
    expect(audit.rowCount).toBe(1);
  });

  it('needs a reason and the owner; no role can UPDATE, DELETE or TRUNCATE an invoice table', async () => {
    const { order } = await orderWithLoads([900]);
    const inv = await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY });
    if (!inv.ok) throw new Error(inv.error);
    expect(await cancelInvoice(app, users.owner, inv.value.id, '  ', { today: TODAY })).toEqual({
      ok: false,
      error: 'REASON_REQUIRED',
    });
    await expect(
      cancelInvoice(app, users.office, inv.value.id, 'oups', { today: TODAY }),
    ).rejects.toBeDefined();
    const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
    try {
      for (const table of ['invoice', 'invoice_line']) {
        const { rows } = await migrator.query<{ p: string }>(
          `select privilege_type as p from information_schema.role_table_grants where grantee = 'belgobeton_app' and table_name = $1`,
          [table],
        );
        expect(rows.map((x) => x.p).sort(), table).toEqual(['INSERT', 'SELECT']);
      }
    } finally {
      await migrator.end();
    }
  });
});

describe('legal deadlines: invoices to issue and to collect (AC-LED-15)', () => {
  it('a delivered order has an invoice to issue by the end of the month; once invoiced, a receivable on the due date', async () => {
    const { order } = await orderWithLoads([4000]);
    const mine = async () =>
      (await legalDeadlines(app, users.owner, { asOf: TODAY })).filter(
        (d) => d.documentCode === order.code || d.documentCode.startsWith('FA-'),
      );
    const toIssue = (await mine()).find((d) => d.documentCode === order.code);
    expect(toIssue).toMatchObject({
      kind: 'invoice_to_issue',
      date: '2026-06-30',
      status: 'overdue',
      amountCentimes: null,
    });
    const inv = await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY });
    if (!inv.ok) throw new Error(inv.error);
    expect((await mine()).find((d) => d.documentCode === order.code)).toBeUndefined();
    const due = (await legalDeadlines(app, users.owner, { asOf: TODAY })).find(
      (d) => d.documentCode === inv.value.number,
    );
    expect(due).toMatchObject({
      kind: 'receivable_due',
      date: '2026-09-01',
      status: 'upcoming',
      amountCentimes: 374_400,
    });
    // A credit note takes it off the list.
    await cancelInvoice(app, users.owner, inv.value.id, 'Erreur (test)', { today: TODAY });
    expect(
      (await legalDeadlines(app, users.owner, { asOf: TODAY })).find(
        (d) => d.documentCode === inv.value.number,
      ),
    ).toBeUndefined();
  });
});

describe('the client statement shows the invoice and the credit note (AC-LED-19)', () => {
  it('as documents of the commercial section that do not move the balance; the summary nets them', async () => {
    const { order } = await orderWithLoads([6000]);
    const clientId = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ client_id: string }>('select client_id from sales_order where id = $1', [order.id]),
      )
    ).rows[0]?.client_id as string;
    const before = await getClientStatement(app, users.owner, clientId, {}, { today: TODAY });
    const inv = await createInvoice(app, users.owner, { orderCode: order.code }, { today: TODAY });
    if (!inv.ok) throw new Error(inv.error);
    const mid = await getClientStatement(app, users.owner, clientId, {}, { today: TODAY });
    expect(mid?.statement.closing).toBe(before?.statement.closing);
    expect(mid?.statement.summary.invoiced).toBe(468_000 + 93_600);
    expect(mid?.statement.commercial.map((r) => r.type)).toEqual(['order', 'invoice']);
    const cn = await cancelInvoice(app, users.owner, inv.value.id, 'Erreur de prix', { today: TODAY });
    expect(cn.ok).toBe(true);
    const after = await getClientStatement(app, users.owner, clientId, {}, { today: TODAY });
    expect(after?.statement.summary.invoiced).toBe(0);
    expect(after?.statement.commercial.map((r) => [r.type, r.status])).toEqual([
      ['order', 'booked'],
      ['invoice', 'cancelled'],
      ['credit_note', 'booked'],
    ]);
    await expect(getClientStatement(app, users.office, clientId, {}, { today: TODAY })).rejects.toBeDefined();
  });
});

describe('what the action changed, by role (AC-LED-26)', () => {
  it('the owner sees the receivable the invoice creates; office gets the document number and nothing about money', async () => {
    const a = await orderWithLoads([5000]);
    const owner = await createInvoice(app, users.owner, { orderCode: a.order.code }, { today: TODAY });
    if (!owner.ok) throw new Error(owner.error);
    expect(owner.value.effects).toEqual([
      { kind: 'document', document: 'invoice', code: owner.value.number },
      { kind: 'receivable', clientCode: expect.stringMatching(/^CLT-/), amountCentimes: 468_000 },
    ]);
    const b = await orderWithLoads([5000]);
    const office = await createInvoice(app, users.office, { orderCode: b.order.code }, { today: TODAY });
    if (!office.ok) throw new Error(office.error);
    expect(office.value.effects).toEqual([
      { kind: 'document', document: 'invoice', code: office.value.number },
    ]);
  });
});

describe('visibility (DECISIONS 81)', () => {
  it('office creates blind; partner, plant and office read nothing; owner and support read', async () => {
    const { order } = await orderWithLoads([600]);
    const inv = await createInvoice(app, users.office, { orderCode: order.code }, { today: TODAY });
    if (!inv.ok) throw new Error(inv.error);
    for (const role of ['office', 'partner', 'plant'] as const) {
      expect((await inCtx(users[role], (tx) => tx.query('select 1 from invoice'))).rows, role).toEqual([]);
      expect((await inCtx(users[role], (tx) => tx.query('select 1 from invoice_line'))).rows, role).toEqual(
        [],
      );
    }
    await expect(listInvoices(app, users.office)).rejects.toBeDefined();
    await expect(listInvoices(app, users.plant)).rejects.toBeDefined();
    const listed = await listInvoices(app, users.support);
    expect(listed.find((i) => i.id === inv.value.id)?.totalTtcCentimes).toBe(56_160);
    expectNoFields(inv.ok ? inv.value : null, ['totalTtcCentimes', 'totalHtCentimes']);
  });
});
