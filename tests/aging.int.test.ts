import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { addOpeningOpenItem, type AgingParty, agingSides, agingToCsv, getAging } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { ensureOpening, moneyMaster } from './helpers/ledger-fixtures';

// T19c B2 (D245): the aging screen's service. Buckets are days PAST due; the total of a party is the sum of its buckets and equals what it owes; each role reads its own side only.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());
const marker = `agi${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TODAY = '2026-12-15';
const users = {} as Record<
  'owner' | 'app_admin' | 'office_sales' | 'office_purchases' | 'plant' | 'office',
  SessionUser
>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
let detailed = '';
let single = '';
let supplierId = '';
const name = (id: string) => (r: { parties: AgingParty[] }) => r.parties.find((p) => p.partyId === id);
beforeAll(async () => {
  for (const role of ['owner', 'app_admin', 'office_sales', 'office_purchases', 'plant', 'office'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  supplierId = (await moneyMaster(app, users.owner.id, marker)).supplierId;
  await ensureOpening(app, users.owner.id, marker);
  const mk = () =>
    inCtx(
      users.owner,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
            [`${marker} client ${randomUUID()}`],
          )
        ).rows[0]!.id,
    );
  detailed = await mk();
  single = await mk();
  const line = (col: string, id: string, amount: number) =>
    inCtx(users.owner, (tx) =>
      tx.query(
        `insert into opening_party_balance (id, ${col}, amount_centimes, created_by) values (gen_random_uuid(), $1, $2, $3)`,
        [id, amount, users.owner.id],
      ),
    );
  await line('client_id', detailed, 100_000 + 20_000 + 3_000 + 400 + 50);
  await line('client_id', single, 77_700);
  await line('supplier_id', supplierId, 9_000);
  const item = async (extra: object) =>
    expect((await addOpeningOpenItem(app, users.owner, { invoiceDate: '2026-01-01', ...extra })).ok).toBe(
      true,
    );
  const c = (due: string, n: number, bal: number) => ({
    clientId: detailed,
    invoiceNumber: `${marker}-${n}`,
    dueDate: due,
    amountCentimes: bal,
    balanceCentimes: bal,
  });
  await item(c('2026-12-15', 1, 100_000)); // due today: current
  await item(c('2026-12-01', 2, 20_000)); // 14 days late
  await item(c('2026-10-30', 3, 3_000)); // 46 days late
  await item(c('2026-09-30', 4, 400)); // 76 days late
  await item(c('2026-06-30', 5, 50)); // 168 days late
  await item({
    supplierId,
    invoiceNumber: `${marker}-S`,
    dueDate: '2026-11-30',
    amountCentimes: 9_000,
    balanceCentimes: 9_000,
  });
});

describe('the buckets of a client with per-invoice items and one without', () => {
  it('puts each invoice in its bucket by days past due; the total is the sum of the buckets and the party line', async () => {
    const r = await getAging(app, users.owner, 'client', { today: TODAY });
    expect(name(detailed)(r)?.aging).toEqual({
      current: 100_000,
      d1_30: 20_000,
      d31_60: 3_000,
      d61_90: 400,
      d90plus: 50,
      unknown: 0,
      total: 123_450,
    });
    // a party with no per-invoice detail: the single line, age unknown, never counted twice
    expect(name(single)(r)?.aging).toEqual({
      current: 0,
      d1_30: 0,
      d31_60: 0,
      d61_90: 0,
      d90plus: 0,
      unknown: 77_700,
      total: 77_700,
    });
    // the grand total is the sum of the parties shown
    expect(r.total.total).toBe(r.parties.reduce((t, p) => t + p.aging.total, 0));
    for (const p of r.parties)
      expect(p.aging.total).toBe(
        p.aging.current + p.aging.d1_30 + p.aging.d31_60 + p.aging.d61_90 + p.aging.d90plus + p.aging.unknown,
      );
  });

  it('the plant filter drops the opening position (it has no plant); an unknown plant shows nothing of it', async () => {
    const r = await getAging(app, users.owner, 'client', { today: TODAY, plantId: randomUUID() });
    expect(name(detailed)(r)).toBeUndefined();
    expect(name(single)(r)).toBeUndefined();
  });

  it('the supplier side has its own report', async () => {
    const r = await getAging(app, users.owner, 'supplier', { today: TODAY });
    expect(name(supplierId)(r)?.aging).toMatchObject({ d1_30: 9_000, total: 9_000 });
  });

  it('the CSV has one line per party and a total line, amounts with a decimal comma, nothing beyond the screen', async () => {
    const r = await getAging(app, users.owner, 'client', { today: TODAY });
    const csv = agingToCsv(r).split('\n');
    expect(csv[0]).toBe('code;name;current;d1_30;d31_60;d61_90;d90plus;no_due_date;total');
    expect(csv.some((l) => l.includes('1000,00;200,00;30,00;4,00;0,50;0,00;1234,50'))).toBe(true);
    expect(csv.at(-1)).toMatch(/^TOTAL;;/);
  });
});

describe('each role reads its own side', () => {
  it('sides by role', () => {
    expect(agingSides(users.owner)).toEqual(['client', 'supplier']);
    expect(agingSides(users.app_admin)).toEqual(['client', 'supplier']);
    expect(agingSides(users.office_sales)).toEqual(['client']);
    expect(agingSides(users.office_purchases)).toEqual(['supplier']);
    expect(agingSides(users.plant)).toEqual([]);
    expect(agingSides(users.office)).toEqual([]);
  });
  it('the Responsable reads clients and is refused suppliers; the Assistante the reverse; others are refused both', async () => {
    expect(
      (await getAging(app, users.office_sales, 'client', { today: TODAY })).parties.length,
    ).toBeGreaterThan(0);
    await expect(getAging(app, users.office_sales, 'supplier', { today: TODAY })).rejects.toThrow();
    expect(
      (await getAging(app, users.office_purchases, 'supplier', { today: TODAY })).parties.length,
    ).toBeGreaterThan(0);
    await expect(getAging(app, users.office_purchases, 'client', { today: TODAY })).rejects.toThrow();
    for (const who of [users.plant, users.office] as const)
      for (const kind of ['client', 'supplier'] as const)
        await expect(getAging(app, who, kind, { today: TODAY })).rejects.toThrow();
  });
});
