import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelPurchase,
  createPurchase,
  getPurchaseDetail,
  getSupplierStatement,
  issueInstrument,
  legalDeadlines,
  listPurchases,
} from '../src/modules/ledger';
import { createSupplier } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L22 + L19: supplier payments are outgoing instruments allocated to the plan items of a purchase (AC-LED-16); the
// payables on the legal-deadlines read model (AC-LED-15 both ways) fall as they are paid.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const TODAY = '2026-06-10';

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function scene() {
  const supplier = await createSupplier(app, users.owner, {
    name: `Fournisseur paiement ${rand()}`,
    category: 'cement',
  });
  if (!supplier.ok) throw new Error(supplier.error);
  const made = await createPurchase(
    app,
    users.office,
    {
      supplierId: supplier.value.id,
      lines: [{ description: 'Ciment (test)', qtyMilli: 30_000, unitPriceHtCentimes: 145_000 }],
      plan: [
        { method: 'cheque', dueDate: '2026-07-01', percentBp: 5000 },
        { method: 'cheque', dueDate: '2026-08-01', percentBp: 5000 },
      ],
    },
    { today: '2026-06-01' },
  );
  if (!made.ok) throw new Error(made.error);
  return { supplierId: supplier.value.id, purchase: made.value };
}
const pay = (
  user: SessionUser,
  supplierId: string,
  amountCentimes: number,
  purchaseCode: string | null,
  method = 'transfer',
) => issueInstrument(app, user, { supplierId, method, amountCentimes, purchaseCode }, { today: TODAY });
const covered = async (purchaseId: string) =>
  (await getPurchaseDetail(app, users.owner, purchaseId))?.items.map((i) => i.coveredCentimes);

describe('a supplier payment covers the plan items of a purchase (AC-LED-16)', () => {
  it('oldest item first: 30 000,00 on two items of 26 100,00', async () => {
    const s = await scene();
    expect((await getPurchaseDetail(app, users.owner, s.purchase.id))?.purchase.totalTtcCentimes).toBe(
      5_220_000,
    );
    const r = await pay(users.office, s.supplierId, 3_000_000, s.purchase.code);
    if (!r.ok) throw new Error(r.error);
    expect(await covered(s.purchase.id)).toEqual([2_610_000, 390_000]);
    const detail = (await listPurchases(app, users.owner)).find((p) => p.id === s.purchase.id);
    expect(detail?.paidCentimes).toBe(3_000_000);
    // A second payment finishes it; more than what is open covers what is open and no more.
    const r2 = await pay(users.owner, s.supplierId, 5_000_000, s.purchase.code);
    expect(r2.ok).toBe(true);
    expect(await covered(s.purchase.id)).toEqual([2_610_000, 2_610_000]);
  });

  it('office sees no money in the effects; the owner sees the payable covered', async () => {
    const a = await scene();
    const office = await pay(users.office, a.supplierId, 1_000_000, a.purchase.code);
    if (!office.ok) throw new Error(office.error);
    expect(office.value.effects).toEqual([{ kind: 'document', document: 'payment', code: 'transfer' }]);
    const b = await scene();
    const owner = await pay(users.owner, b.supplierId, 1_000_000, b.purchase.code);
    if (!owner.ok) throw new Error(owner.error);
    expect(owner.value.effects).toEqual([
      { kind: 'document', document: 'payment', code: 'transfer' },
      { kind: 'payment_out', method: 'transfer', amountCentimes: 1_000_000, cleared: false },
      { kind: 'payable_covered', purchaseCode: b.purchase.code, amountCentimes: 1_000_000 },
    ]);
  });

  it("a code that is not this supplier's purchase rolls the whole entry back", async () => {
    const a = await scene();
    const b = await scene();
    const before = (
      await inCtx(users.owner, (tx) => tx.query('select count(*)::int as n from payment_instrument'))
    ).rows[0].n;
    expect(await pay(users.office, a.supplierId, 1_000_000, b.purchase.code)).toEqual({
      ok: false,
      error: 'NOTHING_TO_ALLOCATE',
    });
    expect(
      (await inCtx(users.owner, (tx) => tx.query('select count(*)::int as n from payment_instrument')))
        .rows[0].n,
    ).toBe(before);
  });

  it('the database refuses an incoming instrument, another supplier, a cancelled purchase and more than the item', async () => {
    const s = await scene();
    const other = await scene();
    const pi = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>(
          `select i.id from purchase_plan_item i where i.purchase_id = $1 order by seq limit 1`,
          [s.purchase.id],
        ),
      )
    ).rows[0]?.id as string;
    const instrument = async (supplierId: string, amount: number) => {
      const r = await issueInstrument(
        app,
        users.owner,
        { supplierId, method: 'transfer', amountCentimes: amount },
        { today: TODAY },
      );
      if (!r.ok) throw new Error(r.error);
      return r.value.id;
    };
    const allocate = (instrumentId: string, amount: number, item = pi) =>
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into allocation (id, instrument_id, purchase_plan_item_id, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`,
          [instrumentId, item, amount, users.owner.id],
        ),
      );
    await expect(allocate(await instrument(other.supplierId, 100_000), 100_000)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(allocate(await instrument(s.supplierId, 3_000_000), 2_610_001)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(allocate(await instrument(s.supplierId, 100_000), 100_001)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(allocate(await instrument(s.supplierId, 100_000), 100_000)).resolves.toBeDefined();
    // An allocation points at exactly one item: none is refused by the table.
    const loose = await instrument(s.supplierId, 100_000);
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into allocation (id, instrument_id, amount_centimes, created_by) values (gen_random_uuid(), $1, 5, $2)`,
          [loose, users.owner.id],
        ),
      ),
    ).rejects.toBeDefined();
    // A cancelled purchase can no longer be paid.
    expect(
      (await cancelPurchase(app, users.owner, other.purchase.id, 'Annulé (test)', { today: TODAY })).ok,
    ).toBe(true);
    expect(await pay(users.owner, other.supplierId, 100_000, other.purchase.code)).toEqual({
      ok: false,
      error: 'NOTHING_TO_ALLOCATE',
    });
  });

  it('the supplier statement and the payables on the deadlines screen follow the payment', async () => {
    const s = await scene();
    await pay(users.owner, s.supplierId, 3_000_000, s.purchase.code);
    const st = await getSupplierStatement(app, users.owner, s.supplierId, {}, { today: TODAY });
    expect(st?.statement.commercial.map((r) => [r.type, r.amountCentimes])).toEqual([
      ['purchase', 5_220_000],
    ]);
    expect(st?.statement.financial.map((r) => r.amountCentimes)).toEqual([-3_000_000]);
    expect(st?.statement.closing).toBe(2_220_000);
    expect(st?.statement.summary.ordered).toBe(5_220_000);
    const deadlines = (await legalDeadlines(app, users.owner, { asOf: TODAY })).filter(
      (d) => d.documentCode === s.purchase.code,
    );
    expect(deadlines.map((d) => [d.kind, d.date, d.amountCentimes, d.status])).toEqual([
      ['payable_due', '2026-08-01', 2_220_000, 'upcoming'],
    ]);
    await expect(legalDeadlines(app, users.office, { asOf: TODAY })).rejects.toBeDefined();
    expect(Array.isArray(await legalDeadlines(app, users.support, { asOf: TODAY }))).toBe(true);
    // Late: the same payable seen from after its due date.
    const late = (await legalDeadlines(app, users.owner, { asOf: '2026-09-01' })).find(
      (d) => d.documentCode === s.purchase.code,
    );
    expect(late?.status).toBe('overdue');
    expect(randomUUID()).toBeTruthy();
  });
});
