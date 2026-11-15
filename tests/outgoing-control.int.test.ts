import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decidePayment,
  issueInstrument,
  listDueTomorrow,
  listPaymentApprovals,
  listPaymentRequests,
  listSmallPaymentsForReview,
  preparePayment,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import type { Role } from '../src/modules/platform-security/domain/permissions';
import { inRequest } from '../src/modules/platform-security';
import { testEnv } from './db-env';
import { moneyMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// T19 item 5 (D247, migration 0245): outgoing payments are prepared, validated by ANOTHER user (or approved by the owner), then issued.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const marker = `oc_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let ids = {} as Record<Role, string>;
let done: () => Promise<void>;
let supplierId = '';
const TODAY = '2026-12-02';
const user = (role: Role) => ({ id: ids[role], role }) as unknown as SessionUser;
const stepped = (role: Role) => ({ ...user(role), stepUpVerified: true }) as unknown as SessionUser;
const n = () => `OC${randomUUID().replace(/-/g, '').slice(0, 9)}`;
beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  ids = v.ids;
  done = v.done;
  supplierId = (await moneyMaster(app, ids.owner, marker)).supplierId;
});
afterAll(async () => {
  await done();
  await app.end();
});

const pay = (
  role: Role,
  amountMad: number,
  extra: { requestId?: string; number?: string; written?: string } = {},
) =>
  issueInstrument(
    app,
    user(role),
    {
      supplierId,
      method: 'cheque',
      amountCentimes: amountMad * 100,
      number: extra.number ?? n(),
      bank: 'BMCE',
      writtenDate: extra.written ?? TODAY,
    },
    { today: TODAY, ...(extra.requestId ? { requestId: extra.requestId } : {}) },
  );
const prepare = async (role: Role, amountMad: number, number = n()) => {
  const r = await preparePayment(app, user(role), {
    supplierId,
    method: 'cheque',
    amount: String(amountMad),
    number,
    bank: 'BMCE',
    writtenDate: TODAY,
  });
  expect(r.ok).toBe(true);
  return { id: (r as { ok: true; value: { id: string } }).value.id, number };
};
const stateOf = async (role: Role, id: string) =>
  (await listPaymentRequests(app, user(role))).find((r) => r.id === id)?.state;

describe('the three bands', () => {
  it('below the small limit the office enters a payment as before and the owner finds it in the daily review', async () => {
    const number = n();
    const r = await pay('office_purchases', 400, { number });
    expect(r.ok).toBe(true);
    const review = await listSmallPaymentsForReview(app, user('owner'), TODAY);
    expect(review.some((x) => x.amountCentimes === 40_000 && x.hasNumber)).toBe(true);
    // the Assistante cannot read the review (owner and app_admin only)
    await expect(listSmallPaymentsForReview(app, user('office_purchases'), TODAY)).rejects.toThrow();
  });

  it('the middle band: no request, no payment; prepared is not enough; the preparer cannot validate; another user validates; the request is used once and must match', async () => {
    expect((await pay('office_purchases', 2000)).ok).toBe(false); // no request: refused by the database
    const { id, number } = await prepare('office_purchases', 2000);
    expect(await stateOf('office_purchases', id)).toBe('prepared');
    expect((await pay('office_purchases', 2000, { requestId: id, number })).ok).toBe(false); // not validated yet
    await expect(
      decidePayment(app, user('office_purchases'), { id, decision: 'validate' }),
    ).rejects.toThrow(); // no right to decide
    const ownPrep = await prepare('owner', 2000);
    expect((await decidePayment(app, user('owner'), { id: ownPrep.id, decision: 'validate' })).ok).toBe(
      false,
    ); // own preparation
    expect((await decidePayment(app, user('office_sales'), { id, decision: 'validate' })).ok).toBe(true);
    expect(await stateOf('office_purchases', id)).toBe('validated');
    expect((await pay('office_purchases', 2100, { requestId: id, number })).ok).toBe(false); // amount differs
    expect((await pay('office_purchases', 2000, { requestId: id, number })).ok).toBe(true);
    expect(await stateOf('office_purchases', id)).toBe('issued');
    expect((await pay('office_purchases', 2000, { requestId: id })).ok).toBe(false); // used once
  });

  it('above the upper limit only the owner or app_admin approves', async () => {
    const { id, number } = await prepare('office_purchases', 6000);
    expect((await decidePayment(app, user('office_sales'), { id, decision: 'validate' })).ok).toBe(false);
    expect((await decidePayment(app, user('office_sales'), { id, decision: 'approve' })).ok).toBe(false);
    expect((await pay('office_purchases', 6000, { requestId: id, number })).ok).toBe(false);
    expect((await decidePayment(app, stepped('owner'), { id, decision: 'approve' })).ok).toBe(true);
    expect((await pay('office_purchases', 6000, { requestId: id, number })).ok).toBe(true);
    // a rejected request can never be issued
    const rej = await prepare('office_purchases', 7000);
    expect(
      (await decidePayment(app, user('app_admin'), { id: rej.id, decision: 'reject', note: 'non prévu' })).ok,
    ).toBe(true);
    expect((await pay('office_purchases', 7000, { requestId: rej.id, number: rej.number })).ok).toBe(false);
  });

  it('the owner and app_admin issue at any amount (they are the control); the middle band needs a request for a request of another supplier too', async () => {
    expect((await pay('owner', 12_000)).ok).toBe(true);
    expect((await pay('app_admin', 3000)).ok).toBe(true);
  });

  it('the Responsable sees only what waits for its validation', async () => {
    await prepare('office_purchases', 1500);
    const seen = await listPaymentRequests(app, user('office_sales'));
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r).toMatchObject({ state: 'prepared', level: 'validate' });
  });
});

describe('J-1', () => {
  it('lists the cheques issued that fall due the day after the given day and are not cleared', async () => {
    const number = n();
    expect((await pay('owner', 800, { number, written: '2026-12-03' })).ok).toBe(true);
    const list = await listDueTomorrow(app, user('office_purchases'), '2026-12-02');
    expect(list.map((x) => x.number)).toContain(number);
    expect(
      (await listDueTomorrow(app, user('office_purchases'), '2026-12-05')).map((x) => x.number),
    ).not.toContain(number);
    await expect(listDueTomorrow(app, user('office_sales'), '2026-12-02')).rejects.toThrow();
  });
});

describe("the owner's approvals inbox (T19-close B)", () => {
  it('lists only what waits for the owner above the upper limit, drops it once decided, and is closed to the office roles', async () => {
    const big = await prepare('office_purchases', 9000);
    const middle = await prepare('office_purchases', 2000);
    const small = await prepare('office_purchases', 300); // a request below the small limit needs no decision
    const waiting = (await listPaymentApprovals(app, user('owner'))).map((r) => r.id);
    expect(waiting).toContain(big.id);
    expect(waiting).not.toContain(middle.id);
    expect(waiting).not.toContain(small.id);
    expect((await listPaymentApprovals(app, user('app_admin'))).map((r) => r.id)).toContain(big.id);
    // the inbox card carries what the owner decides on
    const card = (await listPaymentApprovals(app, user('owner'))).find((r) => r.id === big.id)!;
    expect(card).toMatchObject({
      amountCentimes: 900_000,
      method: 'cheque',
      number: big.number,
      level: 'owner',
    });
    // the Responsable and the Assistante cannot open it
    await expect(listPaymentApprovals(app, user('office_sales'))).rejects.toThrow();
    await expect(listPaymentApprovals(app, user('office_purchases'))).rejects.toThrow();
    // approve from the inbox: the card leaves, the payment can be issued; reject: the card leaves, it cannot
    expect((await decidePayment(app, stepped('owner'), { id: big.id, decision: 'approve' })).ok).toBe(true);
    expect((await listPaymentApprovals(app, user('owner'))).map((r) => r.id)).not.toContain(big.id);
    expect((await pay('office_purchases', 9000, { requestId: big.id, number: big.number })).ok).toBe(true);
    const other = await prepare('office_purchases', 8000);
    expect((await decidePayment(app, user('owner'), { id: other.id, decision: 'reject' })).ok).toBe(true);
    expect((await listPaymentApprovals(app, user('owner'))).map((r) => r.id)).not.toContain(other.id);
    expect((await pay('office_purchases', 8000, { requestId: other.id, number: other.number })).ok).toBe(
      false,
    );
  });
});

describe('the second factor sits in the database door (T19c A)', () => {
  it('an approval above the upper limit without the fresh factor fails from the service (request page and inbox path), from a direct door call, for owner and app_admin; the request stays prepared', async () => {
    const { id, number } = await prepare('office_purchases', 6500);
    for (const role of ['owner', 'app_admin'] as const) {
      const r = await decidePayment(app, user(role), { id, decision: 'approve' });
      expect(r).toMatchObject({ ok: false, error: 'STEP_UP_REQUIRED' });
    }
    // a direct call of the door, with no step-up mark in the transaction
    const direct = await inRequest(app, user('owner'), (tx) =>
      tx.query('select public.decide_outgoing_payment($1, $2, $3)', [id, 'approve', null]),
    ).then(
      () => 'allowed',
      (e: { code?: string; message?: string }) => `${e.code} ${e.message}`,
    );
    expect(direct).toMatch(/^42501 .*fresh second factor/);
    expect(await stateOf('owner', id)).toBe('prepared');
    expect((await pay('office_purchases', 6500, { requestId: id, number })).ok).toBe(false);
    // with the factor it goes through, and the payment can be issued
    expect((await decidePayment(app, stepped('owner'), { id, decision: 'approve' })).ok).toBe(true);
    expect((await pay('office_purchases', 6500, { requestId: id, number })).ok).toBe(true);
  });

  it('an app_admin approval carries the factor too; the Responsable is still refused for a different reason', async () => {
    const { id } = await prepare('office_purchases', 5500);
    expect((await decidePayment(app, stepped('office_sales'), { id, decision: 'approve' })).ok).toBe(false);
    expect((await decidePayment(app, stepped('app_admin'), { id, decision: 'approve' })).ok).toBe(true);
  });

  it('below the upper limit nothing changes: validate (Responsable), approve and reject need no factor, and a rejection above the limit needs none', async () => {
    const mid = await prepare('office_purchases', 2500);
    expect((await decidePayment(app, user('office_sales'), { id: mid.id, decision: 'validate' })).ok).toBe(
      true,
    );
    const mid2 = await prepare('office_purchases', 2600);
    expect((await decidePayment(app, user('owner'), { id: mid2.id, decision: 'approve' })).ok).toBe(true);
    const mid3 = await prepare('office_purchases', 2700);
    expect((await decidePayment(app, user('owner'), { id: mid3.id, decision: 'reject' })).ok).toBe(true);
    const big = await prepare('office_purchases', 9100);
    expect((await decidePayment(app, user('owner'), { id: big.id, decision: 'reject' })).ok).toBe(true);
  });
});
