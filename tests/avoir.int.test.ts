import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  allocate,
  cancelInvoice,
  createInvoice,
  getClientStatement,
  issueAvoir,
  listAvoirCandidates,
  listAvoirs,
  listInvoices,
} from '../src/modules/ledger';
import { recordLoss } from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
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

// integration I1.6: the avoir for concrete refused or brought back after it was billed (DECISIONS 93, 94). AC-INT-12.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 6 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `av${randomUUID().replace(/-/g, '').slice(0, 10)}`;
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

/** A client with a 6 m³ load, invoiced (5 616,00 TTC), of which `lostL` litres were refused by the client. */
async function refused(lostL = 2000) {
  const c = await clientWithLoads(app, users.owner.id, master, scene, [[6000]]);
  const deliveryId = c.orders[0]?.deliveryIds[0] as string;
  const made = await createInvoice(app, users.owner, { deliveryIds: [deliveryId] }, { today: TODAY });
  if (!made.ok) throw new Error(made.error);
  const invoice = (
    await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>('select id from invoice where number = $1', [made.value.number]),
    )
  ).rows[0]?.id as string;
  const loss = await recordLoss(app, users.plant, {
    deliveryId,
    volumeL: lostL,
    reason: 'rejected_by_client',
  });
  if (!loss.ok) throw new Error(loss.error);
  return {
    ...c,
    deliveryId,
    invoice,
    invoiceNumber: made.value.number,
    blNo: c.orders[0]?.blNos[0] as string,
  };
}
const invoiceRow = async (id: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query(
        `select i.*, (select json_agg(l order by seq) from invoice_line l where l.invoice_id = i.id) as lines from invoice i where i.id = $1`,
        [id],
      ),
    )
  ).rows[0];
const issue = (actor: SessionUser, deliveryId: string, reason = 'refusé par le client') =>
  issueAvoir(app, actor, { deliveryId, reason }, { today: TODAY });

describe('the avoir of refused concrete (AC-INT-12)', () => {
  it('is a candidate once the load is billed and lost; the amount is the lost litres at the invoice line price with VAT', async () => {
    const r = await refused();
    const candidate = (await listAvoirCandidates(app, users.owner)).find(
      (c) => c.deliveryId === r.deliveryId,
    );
    // 2 m³ at 780,00 = 1 560,00 HT, 312,00 VAT, 1 872,00 TTC
    expect(candidate).toMatchObject({
      blNo: r.blNo,
      invoiceNumber: r.invoiceNumber,
      lostL: 2000,
      lossReason: 'rejected_by_client',
      amountHtCentimes: 156_000,
      amountVatCentimes: 31_200,
      amountTtcCentimes: 187_200,
    });
  });

  it('is issued by the owner with its own AV number, referencing the invoice, the BL and the loss; the invoice is never edited', async () => {
    const r = await refused();
    const before = await invoiceRow(r.invoice);
    const made = await issue(users.owner, r.deliveryId);
    if (!made.ok) throw new Error(made.error);
    expect(made.value.number).toMatch(/^AV-2026-\d{5}$/);
    expect(made.value.effects.map((e) => e.kind)).toEqual(['document', 'receivable']);
    expect(await invoiceRow(r.invoice)).toEqual(before);
    const view = (await listAvoirs(app, users.owner)).find((a) => a.number === made.value.number);
    expect(view).toMatchObject({
      invoiceId: r.invoice,
      invoiceNumber: r.invoiceNumber,
      deliveryId: r.deliveryId,
      blNo: r.blNo,
      lossReason: 'rejected_by_client',
      volumeL: 2000,
      totalHtCentimes: 156_000,
      totalVatCentimes: 31_200,
      totalTtcCentimes: 187_200,
      appliedCentimes: 187_200,
    });
    expect((await listAvoirCandidates(app, users.owner)).some((c) => c.deliveryId === r.deliveryId)).toBe(
      false,
    );
  });

  it('numbers its avoirs gaplessly, apart from the invoices', async () => {
    const a = await refused(1000);
    const b = await refused(3000);
    const first = await issue(users.owner, a.deliveryId);
    const second = await issue(users.owner, b.deliveryId);
    if (!first.ok || !second.ok) throw new Error('refused');
    const n = (x: string) => Number(x.slice(-5));
    expect(n(second.value.number)).toBe(n(first.value.number) + 1);
  });

  it('is issued once per loss record: a second attempt finds nothing to credit', async () => {
    const r = await refused();
    expect((await issue(users.owner, r.deliveryId)).ok).toBe(true);
    expect(await issue(users.owner, r.deliveryId)).toEqual({ ok: false, error: 'NOTHING_TO_CREDIT' });
    const parallel = await Promise.all(
      Array.from({ length: 4 }, async () => issue(users.owner, (await refused()).deliveryId)),
    );
    expect(parallel.every((p) => p.ok)).toBe(true);
  });

  it('lowers what the client owes: the invoice is part paid by the credit, the plan items are covered, the statement carries it', async () => {
    const r = await refused();
    const statement = async () => {
      const s = await getClientStatement(app, users.owner, r.clientId, {}, { today: TODAY });
      if (!s) throw new Error('no statement');
      return s.statement;
    };
    const before = await statement();
    const made = await issue(users.owner, r.deliveryId);
    if (!made.ok) throw new Error(made.error);
    const after = await statement();
    const line = after.commercial.find((l) => l.type === 'avoir');
    expect(line).toMatchObject({
      code: made.value.number,
      amountCentimes: -187_200,
      counted: true,
      status: 'booked',
    });
    expect(Number(after.closing)).toBe(Number(before.closing) - 187_200);
    const invoice = (await listInvoices(app, users.owner)).find((i) => i.id === r.invoice);
    expect(invoice).toMatchObject({
      totalTtcCentimes: 561_600,
      paidCentimes: 187_200,
      paymentState: 'partial',
    });
  });

  it('when the order is already paid in full, the avoir still exists and applies nothing (a credit in the client favour)', async () => {
    const r = await refused();
    const cheque = await inCtx(users.owner, (tx) =>
      insertInstrument(tx, users.owner.id, { clientId: r.clientId, amountCentimes: 936_000 }),
    );
    expect(
      (
        await allocate(app, users.owner, {
          instrumentId: cheque.id,
          itemId: r.orders[0]?.itemIds[0],
          amountCentimes: 936_000,
        })
      ).ok,
    ).toBe(true);
    const made = await issue(users.owner, r.deliveryId);
    if (!made.ok) throw new Error(made.error);
    const view = (await listAvoirs(app, users.owner)).find((a) => a.number === made.value.number);
    expect(view).toMatchObject({ totalTtcCentimes: 187_200, appliedCentimes: 0 });
  });

  it('refuses a load that is not billed, not lost, or whose invoice is cancelled', async () => {
    const unbilled = await clientWithLoads(app, users.owner.id, master, scene, [[1000]]);
    const id = unbilled.orders[0]?.deliveryIds[0] as string;
    await recordLoss(app, users.plant, { deliveryId: id, volumeL: 500, reason: 'quality' });
    expect(await issue(users.owner, id)).toEqual({ ok: false, error: 'NOTHING_TO_CREDIT' });
    const noLoss = await clientWithLoads(app, users.owner.id, master, scene, [[1000]]);
    expect(await issue(users.owner, noLoss.orders[0]?.deliveryIds[0] as string)).toEqual({
      ok: false,
      error: 'NOTHING_TO_CREDIT',
    });
    const cancelled = await refused();
    expect((await cancelInvoice(app, users.owner, cancelled.invoice, 'erreur', { today: TODAY })).ok).toBe(
      true,
    );
    expect(await issue(users.owner, cancelled.deliveryId)).toEqual({ ok: false, error: 'NOTHING_TO_CREDIT' });
    expect(
      (await listAvoirCandidates(app, users.owner)).some((c) => c.deliveryId === cancelled.deliveryId),
    ).toBe(false);
  });

  it('needs a reason', async () => {
    const r = await refused();
    expect(await issue(users.owner, r.deliveryId, ' ')).toEqual({ ok: false, error: 'INVALID' });
    expect(await issue(users.owner, r.deliveryId, 'ab')).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('who may (AC-INT-12)', () => {
  it('only the owner issues; support reads; office, partner and plant read and issue nothing', async () => {
    const r = await refused();
    for (const role of ['office', 'partner', 'plant', 'support'] as const)
      await expect(issue(users[role], r.deliveryId)).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ['office', 'partner', 'plant'] as const) {
      await expect(listAvoirs(app, users[role])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listAvoirCandidates(app, users[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(listAvoirs(app, users.support)).resolves.toBeDefined();
  });

  it('the database refuses the function to everyone but the owner, and a direct row to everyone', async () => {
    const r = await refused();
    for (const role of ['office', 'partner', 'plant', 'support'] as const)
      await expect(
        inCtx(users[role], (tx) =>
          tx.query('select public.issue_avoir($1, $2, $3)', [r.deliveryId, 'essai', TODAY]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into avoir (id, number, invoice_id, delivery_id, loss_id, client_id, avoir_date, volume_l, unit_price_ht_centimes,
                              vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reason, created_by)
           select gen_random_uuid(), 'AV-2026-99999', $1, $2, x.id, $3, current_date, 2000, 78000, 2000, 156000, 31200, 187200, 'x', $4
             from delivery_loss x where x.delivery_id = $2`,
          [r.invoice, r.deliveryId, r.clientId, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the database refuses a credit row that does not fit the avoir: another order, more than the avoir', async () => {
    const r = await refused();
    const other = await refused();
    const made = await issue(users.owner, r.deliveryId);
    if (!made.ok) throw new Error(made.error);
    const avoirId = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>('select id from avoir where number = $1', [made.value.number]),
      )
    ).rows[0]?.id as string;
    const credit = (item: string, amount: number) =>
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into allocation (id, avoir_id, payment_plan_item_id, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`,
          [avoirId, item, amount, users.owner.id],
        ),
      );
    await expect(credit(other.orders[0]?.itemIds[0] as string, 100)).rejects.toMatchObject({ code: '23514' });
    await expect(credit(r.orders[0]?.itemIds[0] as string, 100)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('more than the avoir'),
    });
  });
});
