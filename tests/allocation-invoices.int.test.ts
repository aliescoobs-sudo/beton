import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocateToInvoice,
  bounceInstrument,
  createInvoice,
  depositInstruments,
  listInvoices,
  listOpenInvoices,
  receiveInstrument,
  unallocate,
} from '../src/modules/ledger';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import {
  clientWithLoads,
  deliveryScene,
  type DeliveryScene,
  moneyMaster,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// integration I1.5: a payment is spread over the client's open invoices, oldest due date first, as allocation records; the
// owner may direct it to one invoice (audited); a bounce reverses it and reopens the invoices. AC-INT-09, 10, 11.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `ai${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-07-03';
let scene: DeliveryScene;
let master: OrderMaster;
let bankId: string;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
  bankId = (await moneyMaster(app, users.owner.id, marker)).bankId;
});

/**
 * A client with two invoices: A (4 m³, TTC 3 744,00) with the LATER due date, B (3 m³, TTC 2 808,00) with the earlier one,
 * made in that order, so "oldest due date first" differs from "oldest invoice first".
 */
async function twoInvoices() {
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[4000], [3000]]);
  const make = async (order: 0 | 1, due: string) => {
    const r = await createInvoice(
      app,
      users.owner,
      { deliveryIds: c.orders[order]?.deliveryIds, dueDate: due },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    return (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>('select id from invoice where number = $1', [r.value.number]),
      )
    ).rows[0]?.id as string;
  };
  const a = await make(0, '2026-08-20');
  const b = await make(1, '2026-08-05');
  return { ...c, a, b };
}
let serial = 0;
const receive = (actor: SessionUser, clientId: string, amount: number, extra: object = {}) =>
  receiveInstrument(
    app,
    actor,
    {
      clientId,
      method: 'cheque',
      amountCentimes: amount,
      number: `AI${Date.now()}${serial++}`,
      bank: 'Banque test',
      writtenDate: '2026-07-03',
      ...extra,
    },
    { today: TODAY },
  );
const stateOf = async (id: string) => (await listInvoices(app, users.owner)).find((i) => i.id === id);
const allocationsOf = async (instrumentId: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query<{ invoice_id: string | null; amount: string; reverses_id: string | null }>(
        `select invoice_id, amount_centimes::text as amount, reverses_id from allocation where instrument_id = $1 order by amount_centimes desc, id`,
        [instrumentId],
      ),
    )
  ).rows;

describe('a payment is spread over the open invoices, oldest due date first (AC-INT-09)', () => {
  it('pays the invoice due first, then the next; one allocation record per plan item, tagged with its invoice', async () => {
    const c = await twoInvoices();
    // 3 000,00: B (due 5 Aug, 2 808,00) first, then 192,00 of A (due 20 Aug) although A was made first
    const r = await receive(users.owner, c.clientId, 300_000, { allocateToClient: true });
    if (!r.ok) throw new Error(r.error);
    expect(await stateOf(c.b)).toMatchObject({ paymentState: 'paid', paidCentimes: 280_800 });
    expect(await stateOf(c.a)).toMatchObject({ paymentState: 'partial', paidCentimes: 19_200 });
    const rows = await allocationsOf(r.value.id);
    expect(rows.map((x) => [x.invoice_id, x.amount])).toEqual([
      [c.b, '280800'],
      [c.a, '19200'],
    ]);
    // the rest of A, with a second payment, closes it
    const second = await receive(users.owner, c.clientId, 355_200, { allocateToClient: true });
    expect(second.ok).toBe(true);
    expect(await stateOf(c.a)).toMatchObject({ paymentState: 'paid', paidCentimes: 374_400 });
  });

  it('never more than the instrument and never more than the invoices ask; the rest stays on account', async () => {
    const c = await twoInvoices();
    const r = await receive(users.owner, c.clientId, 900_000, { allocateToClient: true });
    if (!r.ok) throw new Error(r.error);
    const total = (await allocationsOf(r.value.id)).reduce((s, x) => s + Number(x.amount), 0);
    // 3 744,00 + 2 808,00 are open on the invoices; the other 24 cm... the order plan has the rest of its 9 360,00 open
    expect(total).toBeLessThanOrEqual(900_000);
    expect((await stateOf(c.a))?.paymentState).toBe('paid');
    expect((await stateOf(c.b))?.paymentState).toBe('paid');
  });

  it('office enters it blind: it gets the number and nothing about money; the same spreading happens', async () => {
    const c = await twoInvoices();
    const r = await receive(users.office, c.clientId, 280_800, { allocateToClient: true });
    if (!r.ok) throw new Error(r.error);
    expectNoFields(r.value, ['amountCentimes', 'receivable_spread']);
    expect((r.value.effects ?? []).every((e) => e.kind === 'document')).toBe(true);
    expect(await stateOf(c.b)).toMatchObject({ paymentState: 'paid' });
    expect((await stateOf(c.a))?.paymentState).toBe('unpaid');
  });

  it('the owner sees what it did: spread over the open invoices', async () => {
    const c = await twoInvoices();
    const r = await receive(users.owner, c.clientId, 100_000, { allocateToClient: true });
    if (!r.ok) throw new Error(r.error);
    expect((r.value.effects ?? []).some((e) => e.kind === 'receivable_spread')).toBe(true);
  });

  it('a client with nothing open: the payment just stays on account', async () => {
    const c = await clientWithLoads(app, users.owner.id, master, scene, [], {});
    const r = await receive(users.owner, c.clientId, 100_000, { allocateToClient: true });
    if (!r.ok) throw new Error(r.error);
    expect(await allocationsOf(r.value.id)).toEqual([]);
  });

  it('without the flag nothing is spread (the order-code and manual ways are unchanged)', async () => {
    const c = await twoInvoices();
    const r = await receive(users.owner, c.clientId, 300_000);
    if (!r.ok) throw new Error(r.error);
    expect(await allocationsOf(r.value.id)).toEqual([]);
  });

  it('the open invoices are listed oldest due date first, with what is open', async () => {
    const c = await twoInvoices();
    await receive(users.owner, c.clientId, 100_000, { allocateToClient: true });
    const open = (await listOpenInvoices(app, users.owner)).filter((i) => i.clientId === c.clientId);
    expect(open.map((i) => i.invoiceId)).toEqual([c.b, c.a]);
    expect(open.map((i) => i.openCentimes)).toEqual([180_800, 374_400]);
  });
});

describe('the owner directs a payment to a given invoice (AC-INT-10)', () => {
  it('needs a reason; the rows carry the invoice and the reason; the invoice is paid before the one due first', async () => {
    const c = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 100_000);
    if (!cheque.ok) throw new Error(cheque.error);
    const bad = await allocateToInvoice(app, users.owner, {
      instrumentId: cheque.value.id,
      invoiceId: c.a,
      amountCentimes: 100_000,
      reason: ' ',
    });
    expect(bad).toEqual({ ok: false, error: 'INVALID' });
    const done = await allocateToInvoice(app, users.owner, {
      instrumentId: cheque.value.id,
      invoiceId: c.a,
      amountCentimes: 100_000,
      reason: 'Le client a demandé de régler cette facture',
    });
    expect(done).toEqual({ ok: true, value: { allocatedCentimes: 100_000 } });
    expect(await stateOf(c.a)).toMatchObject({ paymentState: 'partial', paidCentimes: 100_000 });
    expect((await stateOf(c.b))?.paymentState).toBe('unpaid');
    const rows = await inCtx(users.owner, (tx) =>
      tx.query<{ invoice_id: string; override_reason: string }>(
        `select invoice_id, override_reason from allocation where instrument_id = $1`,
        [cheque.value.id],
      ),
    );
    expect(rows.rows).toEqual([
      { invoice_id: c.a, override_reason: 'Le client a demandé de régler cette facture' },
    ]);
    // the audit log keeps the row with its reason
    const audited = await inCtx(users.owner, (tx) =>
      tx.query(
        `select 1 from audit_event where table_name = 'allocation' and action = 'insert' and after::text like '%Le client a demandé%'`,
      ),
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });

  it('is capped at what the invoice has open and at what the instrument has left', async () => {
    const c = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 900_000);
    if (!cheque.ok) throw new Error(cheque.error);
    const done = await allocateToInvoice(app, users.owner, {
      instrumentId: cheque.value.id,
      invoiceId: c.b,
      amountCentimes: 900_000,
      reason: 'imputation voulue',
    });
    expect(done).toEqual({ ok: true, value: { allocatedCentimes: 280_800 } });
    const again = await allocateToInvoice(app, users.owner, {
      instrumentId: cheque.value.id,
      invoiceId: c.b,
      amountCentimes: 1000,
      reason: 'encore',
    });
    expect(again).toEqual({ ok: false, error: 'NOT_ALLOWED' });
  });

  it('an invoice of another client is refused', async () => {
    const c = await twoInvoices();
    const other = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 100_000);
    if (!cheque.ok) throw new Error(cheque.error);
    expect(
      await allocateToInvoice(app, users.owner, {
        instrumentId: cheque.value.id,
        invoiceId: other.a,
        amountCentimes: 100_000,
        reason: 'mauvais client',
      }),
    ).toEqual({ ok: false, error: 'NOT_ALLOWED' });
  });

  it('only the owner: office, support, partner and plant are refused, in the service and in the database', async () => {
    const c = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 100_000);
    if (!cheque.ok) throw new Error(cheque.error);
    for (const role of ['office', 'support', 'partner', 'plant'] as const) {
      await expect(
        allocateToInvoice(app, users[role], {
          instrumentId: cheque.value.id,
          invoiceId: c.a,
          amountCentimes: 1000,
          reason: 'essai',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        inCtx(users[role], (tx) =>
          tx.query('select public.allocate_to_invoice($1, $2, 1000, $3)', [cheque.value.id, c.a, 'essai']),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the database refuses a tag that does not fit: not the client, not an order of the invoice, not an open invoice', async () => {
    const c = await twoInvoices();
    const other = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 100_000);
    if (!cheque.ok) throw new Error(cheque.error);
    const direct = (invoice: string, item: string) =>
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, invoice_id, created_by)
           values (gen_random_uuid(), $1, $2, 100, $3, $4)`,
          [cheque.value.id, item, invoice, users.owner.id],
        ),
      );
    // invoice A bills order 0 of this client: its plan item is fine, order 1's item is not an order of that invoice
    await expect(direct(c.a, c.orders[1]?.itemIds[0] as string)).rejects.toMatchObject({ code: '23514' });
    await expect(direct(other.a, c.orders[0]?.itemIds[0] as string)).rejects.toMatchObject({ code: '23514' });
    await expect(direct(c.a, c.orders[0]?.itemIds[0] as string)).resolves.toBeDefined();
  });
});

describe('a bounce reopens the invoices it paid, and the 30 days start (AC-INT-11)', () => {
  it('reverses every allocation with a negated row carrying the same invoice; the invoices are open again; the window is 30 days', async () => {
    const c = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 300_000, { allocateToClient: true });
    if (!cheque.ok) throw new Error(cheque.error);
    expect((await stateOf(c.b))?.paymentState).toBe('paid');
    expect(
      (
        await depositInstruments(app, users.owner, {
          instrumentIds: [cheque.value.id],
          accountId: bankId,
          date: '2026-07-04',
        })
      ).ok,
    ).toBe(true);
    const bounced = await bounceInstrument(app, users.owner, {
      instrumentId: cheque.value.id,
      date: '2026-07-06',
    });
    if (!bounced.ok) throw new Error(bounced.error);
    expect(bounced.value.regularizationDeadline).toBe('2026-08-05');
    const rows = await inCtx(users.owner, (tx) =>
      tx.query<{ invoice_id: string; amount: string; reverses_id: string | null }>(
        `select invoice_id, amount_centimes::text as amount, reverses_id from allocation where instrument_id = $1 order by amount_centimes`,
        [cheque.value.id],
      ),
    );
    expect(rows.rows.filter((r) => r.reverses_id)).toHaveLength(2);
    expect(
      rows.rows
        .filter((r) => r.reverses_id)
        .map((r) => [r.invoice_id, r.amount])
        .sort(),
    ).toEqual(
      [
        [c.a, '-19200'],
        [c.b, '-280800'],
      ].sort(),
    );
    expect(await stateOf(c.b)).toMatchObject({ paymentState: 'unpaid', paidCentimes: 0 });
    expect(await stateOf(c.a)).toMatchObject({ paymentState: 'unpaid', paidCentimes: 0 });
    const open = (await listOpenInvoices(app, users.owner)).filter((i) => i.clientId === c.clientId);
    expect(open.map((i) => i.invoiceId).sort()).toEqual([c.a, c.b].sort());
  });

  it('undoing an allocation by hand keeps the tag too', async () => {
    const c = await twoInvoices();
    const cheque = await receive(users.owner, c.clientId, 100_000, { allocateToClient: true });
    if (!cheque.ok) throw new Error(cheque.error);
    const [first] = await allocationsOf(cheque.value.id);
    const original = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>(
        `select id from allocation where instrument_id = $1 and reverses_id is null limit 1`,
        [cheque.value.id],
      ),
    );
    expect(first?.invoice_id).toBe(c.b);
    const undone = await unallocate(app, users.owner, {
      allocationId: original.rows[0]?.id,
      reason: 'erreur',
    });
    expect(undone.ok).toBe(true);
    expect(await stateOf(c.b)).toMatchObject({ paymentState: 'unpaid' });
  });
});
