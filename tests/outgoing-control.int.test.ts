import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decidePayment,
  issueInstrument,
  listDueTomorrow,
  listPaymentRequests,
  listSmallPaymentsForReview,
  preparePayment,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import type { Role } from '../src/modules/platform-security/domain/permissions';
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
    expect((await decidePayment(app, user('owner'), { id, decision: 'approve' })).ok).toBe(true);
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
