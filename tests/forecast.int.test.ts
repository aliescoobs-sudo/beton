import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  addOpeningInstalment,
  addOpeningObligation,
  getCashForecast,
  issueInstrument,
  receiveInstrument,
} from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { ensureOpening, moneyMaster } from './helpers/ledger-fixtures';

// T19c B3 (D245): the cash forecast. The shared test database holds other suites' rows, so every figure is checked as a DIFFERENCE before and after the fixtures.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());
const marker = `fc${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const TODAY = '2026-12-15';
const users = {} as Record<
  'owner' | 'app_admin' | 'office_sales' | 'office_purchases' | 'plant',
  SessionUser
>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
let clientId = '';
let supplierId = '';
const num = (s: string) => `${marker}${s}`.slice(0, 20);
beforeAll(async () => {
  for (const role of ['owner', 'app_admin', 'office_sales', 'office_purchases', 'plant'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
  await ensureOpening(app, users.owner.id, marker);
  clientId = await inCtx(
    users.owner,
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
          [`${marker} client`],
        )
      ).rows[0]!.id,
  );
});

describe('the forecast over the next 90 days', () => {
  it('adds the client cheques, the issued cheques and the instalments to the right horizons; the net line is for the roles that read both sides', async () => {
    const before = await getCashForecast(app, users.owner, { today: TODAY });
    const chq = (written: string, amount: number, n: string) => ({
      method: 'cheque',
      amountCentimes: amount,
      clientId,
      number: num(n),
      bank: 'B',
      writtenDate: written,
    });
    // client cheques: +10 days, +45 days, +100 days (outside)
    for (const [w, a, n] of [
      ['2026-12-25', 10_000, 'a'],
      ['2027-01-29', 200_000, 'b'],
      ['2027-03-25', 9_000_000, 'c'],
    ] as const)
      expect(
        (await receiveInstrument(app, users.office_sales, chq(w, a, n), { today: '2026-12-10' })).ok,
      ).toBe(true);
    // a cheque we issued, due in 20 days (owner enters it: the control gate lets the owner through)
    expect(
      (
        await issueInstrument(
          app,
          users.owner,
          {
            supplierId,
            method: 'cheque',
            amountCentimes: 3_000,
            number: num('s'),
            bank: 'B',
            writtenDate: '2027-01-04',
          },
          { today: TODAY },
        )
      ).ok,
    ).toBe(true);
    // a loan with one instalment in 70 days and one already past
    const ob = await addOpeningObligation(app, users.owner, {
      kind: 'loan',
      lender: `Banque ${marker}`,
      reference: num('L'),
    });
    expect(ob.ok).toBe(true);
    const oid = (ob as { ok: true; value: { id: string } }).value.id;
    for (const [d, a] of [
      ['2027-02-23', 500],
      ['2026-12-01', 77],
    ] as const)
      expect(
        (await addOpeningInstalment(app, users.owner, { obligationId: oid, dueDate: d, amountCentimes: a }))
          .ok,
      ).toBe(true);

    const after = await getCashForecast(app, users.owner, { today: TODAY });
    const diff = (k: 'incoming' | 'outgoing' | 'net') =>
      Object.fromEntries(
        (['overdue', 'd30', 'd60', 'd90'] as const).map((c) => [c, after[k][c] - before[k][c]]),
      );
    expect(diff('incoming')).toEqual({ overdue: 0, d30: 10_000, d60: 210_000, d90: 210_000 });
    expect(diff('outgoing')).toEqual({ overdue: 0, d30: 3_000, d60: 3_000, d90: 3_500 }); // the past instalment is not shown as unpaid
    expect(diff('net')).toEqual({ overdue: 0, d30: 7_000, d60: 207_000, d90: 206_500 });
    expect(
      after.items.filter((i) => i.label.includes(marker)).map((i) => [i.kind, i.amountCentimes]),
    ).toEqual([
      ['client_cheque', 10_000],
      ['issued_cheque', 3_000],
      ['client_cheque', 200_000],
      ['instalment', 500],
    ]);
    expect(after.sides).toEqual({ client: true, supplier: true, instalments: true, net: true });
  });

  it('the Responsable sees the client cheques only; the Assistante the issued cheques only; neither sees instalments or the net line', async () => {
    const sales = await getCashForecast(app, users.office_sales, { today: TODAY });
    expect(sales.sides).toEqual({ client: true, supplier: false, instalments: false, net: false });
    expect(sales.items.every((i) => i.kind === 'client_cheque')).toBe(true);
    expect(sales.items.some((i) => i.label.includes(marker))).toBe(true);
    const purchases = await getCashForecast(app, users.office_purchases, { today: TODAY });
    expect(purchases.sides).toEqual({ client: false, supplier: true, instalments: false, net: false });
    expect(purchases.items.every((i) => i.kind === 'issued_cheque')).toBe(true);
    expect(purchases.items.some((i) => i.label.includes(marker))).toBe(true);
    expect(purchases.items.some((i) => i.kind === 'instalment')).toBe(false);
    const admin = await getCashForecast(app, users.app_admin, { today: TODAY });
    expect(admin.sides.net).toBe(true);
  });

  it('other roles are refused', async () => {
    await expect(getCashForecast(app, users.plant, { today: TODAY })).rejects.toThrow();
  });
});
