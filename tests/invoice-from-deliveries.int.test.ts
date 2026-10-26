import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocate,
  cancelInvoice,
  createInvoice,
  getInvoiceDocument,
  getInvoiceQueue,
  listInvoices,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import {
  deliveryScene,
  type DeliveryScene,
  insertDelivery,
  insertInstrument,
  clientWithLoads,
  newAdvanceInvoice,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// integration I1.4: one invoice from the selected BLs of a client, across orders: grouped by product, advances applied
// once, a BL on one invoice only (also under concurrency), the office door, the payment state. AC-INT-06, 07, 08.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 12 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `ifd${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-07-03';
let scene: DeliveryScene;
let master: OrderMaster;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  master = await orderMaster(app, users.owner.id, marker);
});

const clientWith = (loadsPerOrder: number[][], options: { delivered?: boolean } = {}) =>
  clientWithLoads(app, users.owner.id, master, scene, loadsPerOrder, options);
const numberOf = (r: Awaited<ReturnType<typeof createInvoice>>) => {
  if (!r.ok) throw new Error(r.error);
  return r.value.number;
};
const idOf = async (number: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>('select id from invoice where number = $1', [number]),
    )
  ).rows[0]?.id as string;

describe('one invoice from the selected BLs, across orders (AC-INT-06)', () => {
  it('groups by product, sums the quantity, lists the BL numbers, and the totals are those of the stored lines', async () => {
    const c = await clientWith([[4000, 2000], [3000]]);
    const ids = c.orders.flatMap((o) => o.deliveryIds);
    const number = numberOf(await createInvoice(app, users.owner, { deliveryIds: ids }, { today: TODAY }));
    const doc = await getInvoiceDocument(app, users.owner, await idOf(number));
    expect(doc?.invoice.orderCodes.sort()).toEqual(c.orders.map((o) => o.code).sort());
    expect(doc?.lines).toHaveLength(3);
    expect(doc?.groups).toHaveLength(1);
    expect(doc?.groups[0]).toMatchObject({
      volumeL: 9000,
      amountHtCentimes: 702_000,
      unitPriceHtCentimes: 78_000,
    });
    expect(doc?.groups[0]?.blNos.sort()).toEqual(c.orders.flatMap((o) => o.blNos).sort());
    expect(doc?.invoice).toMatchObject({
      totalHtCentimes: 702_000,
      totalVatCentimes: 140_400,
      totalTtcCentimes: 842_400,
    });
    expect(doc?.advanceCentimes).toBe(0);
    expect(doc?.netToPayCentimes).toBe(842_400);
    // the BLs left the queue
    const queue = (await getInvoiceQueue(app, users.owner)).find((q) => q.clientId === c.clientId);
    expect(queue).toBeUndefined();
  });

  it('the selection may be part of what is waiting: the rest stays in the queue', async () => {
    const c = await clientWith([[4000, 2000]]);
    const first = c.orders[0]?.deliveryIds[0] as string;
    numberOf(await createInvoice(app, users.owner, { deliveryIds: [first] }, { today: TODAY }));
    const q = (await getInvoiceQueue(app, users.owner)).find((x) => x.clientId === c.clientId);
    expect(q?.deliveries.map((d) => d.deliveryId)).toEqual([c.orders[0]?.deliveryIds[1]]);
  });

  it('refuses what is not billable, with one answer: unknown, undelivered, already invoiced, two clients', async () => {
    const a = await clientWith([[1000]]);
    const b = await clientWith([[1000]]);
    const waiting = await clientWith([[1000]], { delivered: false });
    const refused = { ok: false, error: 'NOTHING_TO_INVOICE' };
    expect(await createInvoice(app, users.owner, { deliveryIds: [randomUUID()] }, { today: TODAY })).toEqual(
      refused,
    );
    expect(
      await createInvoice(
        app,
        users.owner,
        { deliveryIds: waiting.orders.flatMap((o) => o.deliveryIds) },
        { today: TODAY },
      ),
    ).toEqual(refused);
    expect(
      await createInvoice(
        app,
        users.owner,
        {
          deliveryIds: [...a.orders.flatMap((o) => o.deliveryIds), ...b.orders.flatMap((o) => o.deliveryIds)],
        },
        { today: TODAY },
      ),
    ).toEqual(refused);
    numberOf(
      await createInvoice(
        app,
        users.owner,
        { deliveryIds: a.orders.flatMap((o) => o.deliveryIds) },
        { today: TODAY },
      ),
    );
    expect(
      await createInvoice(
        app,
        users.owner,
        { deliveryIds: a.orders.flatMap((o) => o.deliveryIds) },
        { today: TODAY },
      ),
    ).toEqual(refused);
  });

  it('a BL is on one invoice only, however many are made at once (database constraint under concurrency)', async () => {
    const c = await clientWith([[1000, 1000]]);
    const ids = c.orders.flatMap((o) => o.deliveryIds);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createInvoice(app, i % 2 ? users.office : users.owner, { deliveryIds: ids }, { today: TODAY }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'NOTHING_TO_INVOICE')).toBe(true);
    const lines = await inCtx(users.owner, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from invoice_line l join invoice i on i.id = l.invoice_id
          where l.delivery_id = any($1) and i.credit_note_of is null`,
        [ids],
      ),
    );
    expect(Number(lines.rows[0]?.n)).toBe(2);
  });

  it('the database itself refuses a line for a load that is not delivered, or a load billed already, by direct SQL', async () => {
    const waiting = await clientWith([[1000]], { delivered: false });
    const done = await clientWith([[1000]]);
    const doneNumber = numberOf(
      await createInvoice(
        app,
        users.owner,
        { deliveryIds: done.orders.flatMap((o) => o.deliveryIds) },
        { today: TODAY },
      ),
    );
    expect(doneNumber).toBeTruthy();
    const direct = (c: Awaited<ReturnType<typeof clientWith>>, delivery: string) =>
      inCtx(users.owner, async (tx) => {
        const invoice = randomUUID();
        const number = (await tx.query<{ n: string }>(`select public.next_doc_number('FA', 2026, 5) as n`))
          .rows[0]?.n;
        await tx.query(
          `insert into invoice (id, number, order_id, client_id, client_name, invoice_date, issue_deadline, due_date, vat_rate_bp,
                                total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
           values ($1, $2, null, $3, 'x', '2026-07-03', '2026-07-31', '2026-09-01', 2000, 78000, 15600, 93600, $4)`,
          [invoice, number, c.clientId, users.owner.id],
        );
        await tx.query(
          `insert into invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes, line_ht_centimes, created_by)
           values (gen_random_uuid(), $1, 1, $2, 'x', 1000, 78000, 78000, $3)`,
          [invoice, delivery, users.owner.id],
        );
      });
    await expect(direct(waiting, waiting.orders[0]?.deliveryIds[0] as string)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('not delivered'),
    });
    await expect(direct(done, done.orders[0]?.deliveryIds[0] as string)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('already invoiced'),
    });
  });

  it('cancelling the invoice (a credit note) gives its BLs back to the queue', async () => {
    const c = await clientWith([[2000], [1000]]);
    const ids = c.orders.flatMap((o) => o.deliveryIds);
    const number = numberOf(await createInvoice(app, users.owner, { deliveryIds: ids }, { today: TODAY }));
    const credit = await cancelInvoice(app, users.owner, await idOf(number), 'erreur de saisie', {
      today: TODAY,
    });
    expect(credit.ok).toBe(true);
    const q = (await getInvoiceQueue(app, users.owner)).find((x) => x.clientId === c.clientId);
    expect(q?.deliveries.map((d) => d.deliveryId).sort()).toEqual([...ids].sort());
  });
});

describe('the office door (AC-INT-08)', () => {
  it('office sends BL ids and gets the number back, with no amount, no id, no client', async () => {
    const c = await clientWith([[3000]]);
    const r = await createInvoice(
      app,
      users.office,
      { deliveryIds: c.orders.flatMap((o) => o.deliveryIds) },
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.number).toMatch(/^FA-2026-\d{5}$/);
    expect(r.value.id).toBe('');
    expectNoFields(r.value, ['amountCentimes', 'totalTtcCentimes', 'clientName', 'unitPrice']);
    expect(JSON.stringify(r.value)).not.toMatch(/234000|280800/);
    expect(r.value.effects.every((e) => e.kind === 'document')).toBe(true);
  });

  it('partner, plant and support cannot invoice', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      await expect(
        createInvoice(app, users[role], { deliveryIds: [randomUUID()] }, { today: TODAY }),
      ).rejects.toThrow();
    }
  });

  it('refusals are audited, which is what the ten-in-ten-minutes lock-out reads', async () => {
    const probe = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
    // the office user of the suite is shared, so only check that refusals are audited as the lock-out reads them
    await createInvoice(app, probe, { deliveryIds: [randomUUID()] }, { today: TODAY });
    const audited = await inCtx(users.owner, (tx) =>
      tx.query(
        `select 1 from audit_event where table_name = 'invoice_create' and action = 'permission_denied' and actor_user_id = $1`,
        [probe.id],
      ),
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });
});

describe('advances received (AC-INT-07)', () => {
  it('the advance paid on the order is shown once as "Acompte reçu", the net is the total minus it, the total is unchanged', async () => {
    const made = await inCtx(users.owner, (tx) =>
      newAdvanceInvoice(tx, users.owner.id, master, scene, marker),
    );
    expect(made.number).toBeTruthy();
    const id = await idOf(made.number as string);
    const doc = await getInvoiceDocument(app, users.owner, id);
    // 6 m³ at 780,00 = 4 680,00 HT, 5 616,00 TTC; advance 2 808,00
    expect(doc?.invoice.totalTtcCentimes).toBe(561_600);
    expect(doc?.advanceCentimes).toBe(280_800);
    expect(doc?.netToPayCentimes).toBe(280_800);
    // a second invoice for the same order finds no advance left
    const second = await inCtx(users.owner, async (tx) => {
      const d = await insertDelivery(tx, users.owner.id, { ...scene, orderId: made.orderId }, 4000, 2026);
      await tx.query(
        `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values (gen_random_uuid(), $1, now(), null, $2)`,
        [d.id, users.owner.id],
      );
      return d.id;
    });
    const n2 = numberOf(await createInvoice(app, users.owner, { deliveryIds: [second] }, { today: TODAY }));
    const doc2 = await getInvoiceDocument(app, users.owner, await idOf(n2));
    expect(doc2?.advanceCentimes).toBe(0);
    expect(doc2?.netToPayCentimes).toBe(doc2?.invoice.totalTtcCentimes);
  });

  it('an advance bigger than what is invoiced is applied up to the invoice, and the rest waits for the next one', async () => {
    const made = await inCtx(users.owner, (tx) =>
      newAdvanceInvoice(tx, users.owner.id, master, scene, marker, { advanceCentimes: 936_000, loadL: 6000 }),
    );
    const first = await getInvoiceDocument(app, users.owner, await idOf(made.number as string));
    expect(first?.advanceCentimes).toBe(561_600);
    expect(first?.netToPayCentimes).toBe(0);
    const next = await inCtx(users.owner, async (tx) => {
      const d = await insertDelivery(tx, users.owner.id, { ...scene, orderId: made.orderId }, 4000, 2026);
      await tx.query(
        `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values (gen_random_uuid(), $1, now(), null, $2)`,
        [d.id, users.owner.id],
      );
      return d.id;
    });
    const doc = await getInvoiceDocument(
      app,
      users.owner,
      await idOf(numberOf(await createInvoice(app, users.owner, { deliveryIds: [next] }, { today: TODAY }))),
    );
    expect(doc?.advanceCentimes).toBe(374_400);
    expect(doc?.netToPayCentimes).toBe(0);
  });

  it('an invoice cancelled by a credit note frees its advance for the invoice that replaces it', async () => {
    const made = await inCtx(users.owner, (tx) =>
      newAdvanceInvoice(tx, users.owner.id, master, scene, marker),
    );
    const id = await idOf(made.number as string);
    expect((await cancelInvoice(app, users.owner, id, 'prix à revoir', { today: TODAY })).ok).toBe(true);
    const again = numberOf(
      await createInvoice(app, users.owner, { deliveryIds: [made.deliveryId] }, { today: TODAY }),
    );
    const doc = await getInvoiceDocument(app, users.owner, await idOf(again));
    expect(doc?.advanceCentimes).toBe(280_800);
  });
});

describe('payment state of an invoice that bills several orders (D85, extended)', () => {
  it('each order covers its own share: partial, then paid; nothing is stored', async () => {
    const c = await clientWith([[4000, 2000], [3000]]);
    const ids = c.orders.flatMap((o) => o.deliveryIds);
    const number = numberOf(await createInvoice(app, users.owner, { deliveryIds: ids }, { today: TODAY }));
    const id = await idOf(number);
    const state = async () => (await listInvoices(app, users.owner)).find((i) => i.id === id);
    expect(await state()).toMatchObject({
      paymentState: 'unpaid',
      paidCentimes: 0,
      totalTtcCentimes: 842_400,
    });
    const pay = async (itemId: string, amount: number) => {
      const instrument = await inCtx(users.owner, (tx) =>
        insertInstrument(tx, users.owner.id, { clientId: c.clientId, amountCentimes: amount }),
      );
      const r = await allocate(app, users.owner, {
        instrumentId: instrument.id,
        itemId,
        amountCentimes: amount,
      });
      if (!r.ok) throw new Error(r.error);
    };
    // order A's share: 6 m³ = 4 680,00 HT = 5 616,00 TTC
    await pay(c.orders[0]?.itemIds[0] as string, 561_600);
    expect(await state()).toMatchObject({ paymentState: 'partial', paidCentimes: 561_600 });
    // order B's share: 3 m³ = 2 808,00 TTC
    await pay(c.orders[1]?.itemIds[0] as string, 280_800);
    expect(await state()).toMatchObject({ paymentState: 'paid', paidCentimes: 842_400 });
  });

  it('only the owner and support can ask the database for it', async () => {
    for (const role of ['partner', 'office', 'plant'] as const) {
      await expect(
        inCtx(users[role], (tx) => tx.query('select * from public.invoice_payment_state()')),
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
    for (const role of ['owner', 'support'] as const) {
      await expect(
        inCtx(users[role], (tx) => tx.query('select * from public.invoice_payment_state()')),
      ).resolves.toBeDefined();
    }
  });
});
