import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureRoles, recreateDatabase, SCENARIO_TEST_DATABASE } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { withRlsContext } from '../src/lib/db/rls-context';
import { getCashPosition, listInvoices, listPurchases } from '../src/modules/ledger';
import { getStockLevels, seedOperationsScenario } from '../src/modules/operations';
import { seedPilotScenario } from '../src/modules/ledger/service/pilot-scenario';
import { seedPilotMasterData } from '../src/modules/master-data';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L34: the pilot scenario, in a database of its own (the opening date is a singleton, so the shared test
// database cannot host it). Fake data only; dated relative to a fixed "today".
const DATABASE = SCENARIO_TEST_DATABASE;
const TODAY = '2026-10-24';
const allowed = { SIMULATION_ENABLED: true, REAL_DATA: false, NODE_ENV: 'test' };
const base = testEnv();
const env = testEnv(DATABASE);
const pools: pg.Pool[] = [];
const pool = (url: string, max = 2) => {
  const p = new pg.Pool({ connectionString: url, max });
  pools.push(p);
  return p;
};
afterAll(() => Promise.all(pools.map((p) => p.end())));

let app: pg.Pool;
let seed: pg.Pool;
let first: Awaited<ReturnType<typeof seedPilotScenario>>;
let owner: Awaited<ReturnType<typeof realSessionUser>>;

beforeAll(async () => {
  await ensureRoles(base, base.DATABASE_URL_SEED);
  await recreateDatabase(base, DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  seed = pool(env.DATABASE_URL_SEED, 1);
  await seedPilotMasterData(seed, allowed);
  app = pool(env.DATABASE_URL_APP, 3);
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  first = await seedPilotScenario(seed, allowed, TODAY);
}, 120_000);

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'scenario-test' }, fn);
const one = async (sql: string, params: unknown[] = []) =>
  Number((await asOwner((tx) => tx.query<{ n: string }>(sql, params))).rows[0]?.n);

describe('the pilot scenario (L34)', () => {
  it('seeds a mid-size plant: 25 clients, 8 suppliers, about three months of orders', async () => {
    expect(first.applied).toBe(true);
    expect(await one('select count(*)::text as n from client')).toBe(25);
    expect(await one('select count(*)::text as n from supplier')).toBe(8);
    expect(first.orders).toBeGreaterThan(60);
    expect(first.orders).toBeLessThan(160);
    expect(
      await one(`select count(*)::text as n from sales_order where order_date < $1::date - 80`, [TODAY]),
    ).toBeGreaterThan(5);
    expect(
      await one(`select count(*)::text as n from sales_order where delivery_date > $1::date`, [TODAY]),
    ).toBeGreaterThan(0);
  });

  it('has instruments in every state: portfolio, deposited, cleared, bounced inside its window, regularized, disputed, issued', async () => {
    const states = (
      await asOwner((tx) =>
        tx.query<{ state: string; n: string }>(
          `select last.event as state, count(*)::text as n from payment_instrument i
             cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
            group by 1`,
        ),
      )
    ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.state]: Number(r.n) }), {});
    for (const state of [
      'received',
      'deposited',
      'cleared',
      'bounced',
      'regularized',
      'disputed',
      'issued',
    ]) {
      expect(states[state], state).toBeGreaterThan(0);
    }
    // One bounce still inside its 30-day window, one closed without regularization.
    expect(
      await one(
        `select count(*)::text as n from instrument_event e where e.event = 'bounced' and e.regularization_deadline >= $1::date`,
        [TODAY],
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await one(
        `select count(*)::text as n from instrument_event e where e.event = 'bounced' and e.regularization_deadline < $1::date`,
        [TODAY],
      ),
    ).toBeGreaterThanOrEqual(1);
    // Post-dated cheques waiting in the portfolio, and some presented early.
    expect(
      await one(
        `select count(*)::text as n from payment_instrument where direction = 'in' and written_date > $1::date`,
        [TODAY],
      ),
    ).toBeGreaterThan(0);
  });

  it('has running instalment plans: first thirds covered, the rest still to come', async () => {
    expect(
      await one(
        `select count(*)::text as n from payment_plan_item where method = 'installment' and due_date > $1::date`,
        [TODAY],
      ),
    ).toBeGreaterThan(0);
    expect(
      await one(`select count(*)::text as n from payment_plan_item where method = 'lcn'`),
    ).toBeGreaterThan(0);
  });

  it('shows real cash of 600 000 MAD, more with what is coming, and a tight day inside two weeks', async () => {
    const position = await getCashPosition(app, owner);
    expect(position.real).toBe(60_000_000);
    expect(Number(position.incomingUncleared)).toBeGreaterThan(0);
    expect(Number(position.outgoingUncleared)).toBeGreaterThan(0);
    // Day +6: real cash + portfolio due by then - cheques issued for then ends 40 000 MAD (±100) short.
    const horizon = '2026-10-30';
    const portfolio = await one(
      `select coalesce(sum(i.amount_centimes), 0)::text as n from payment_instrument i
         cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
        where i.direction = 'in' and i.method in ('cheque','lcn') and last.event in ('received','deposited') and i.written_date <= $1`,
      [horizon],
    );
    const issued = await one(
      `select coalesce(sum(i.amount_centimes), 0)::text as n from payment_instrument i
         cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last
        where i.direction = 'out' and last.event = 'issued' and i.written_date <= $1`,
      [horizon],
    );
    const balance = Number(position.real) + portfolio - issued;
    expect(balance).toBeLessThanOrEqual(-3_990_000);
    expect(balance).toBeGreaterThanOrEqual(-4_010_000);
  });

  it('records the opening state: date, balances, what parties owed', async () => {
    expect(await one(`select to_char(opening_date, 'YYYYMMDD')::bigint::text as n from ledger_opening`)).toBe(
      20260726,
    );
    expect(await one('select count(*)::text as n from opening_balance')).toBe(3);
    expect(await one('select count(*)::text as n from opening_party_balance')).toBeGreaterThanOrEqual(8);
  });

  it('audits every row as the system actor, and the owner sees them', async () => {
    const orders = await one('select count(*)::text as n from sales_order');
    const audited = await one(
      `select count(*)::text as n from audit_event where table_name = 'sales_order' and action = 'insert' and actor_kind = 'system'`,
    );
    expect(audited).toBe(orders);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const total = `select ((select count(*) from sales_order) + (select count(*) from payment_instrument) + (select count(*) from client))::text as n`;
    const before = await one(total);
    const second = await seedPilotScenario(seed, allowed, TODAY);
    expect(second.applied).toBe(false);
    expect(await one(total)).toBe(before);
  });

  it('refuses outside simulation, on real data and in production', async () => {
    await expect(seedPilotScenario(seed, { ...allowed, SIMULATION_ENABLED: false }, TODAY)).rejects.toThrow(
      /SIMULATION_ENABLED/,
    );
    await expect(seedPilotScenario(seed, { ...allowed, REAL_DATA: true }, TODAY)).rejects.toThrow(
      /REAL_DATA/,
    );
    await expect(seedPilotScenario(seed, { ...allowed, NODE_ENV: 'production' }, TODAY)).rejects.toThrow(
      /production/,
    );
  });

  it('keeps money invisible to office, partner and plant on the seeded data, and the system role cannot write the ledger', async () => {
    for (const role of ['office', 'partner', 'plant'] as const) {
      const user = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
      for (const table of [
        'sales_order',
        'payment_plan_item',
        'payment_instrument',
        'instrument_event',
        'money_movement',
        'allocation',
        'money_account',
        'opening_balance',
        'opening_party_balance',
      ]) {
        const { rows } = await withRlsContext(
          app,
          { userId: user.id, role, requestId: 'scenario-test' },
          (tx) => tx.query(`select 1 from ${table} limit 1`),
        );
        expect(rows, `${role} ${table}`).toEqual([]);
      }
    }
    const system = pool(env.DATABASE_URL_SYSTEM, 1);
    await expect(
      withRlsContext(system, { userId: owner.id, role: 'system', requestId: 'x' }, (tx) =>
        tx.query(`insert into ledger_opening (opening_date, created_by) values ('2026-01-01', $1)`, [
          owner.id,
        ]),
      ),
    ).rejects.toThrow();
  });
});

// operations O8: loads, signed delivery notes, stock, thresholds, purchases and receipts, invoices and a credit note.
describe('the operations part of the pilot scenario (O8)', () => {
  let ops: Awaited<ReturnType<typeof seedOperationsScenario>>;
  beforeAll(async () => {
    ops = await seedOperationsScenario(seed, allowed, TODAY);
  }, 120_000);

  it('loads every order delivered so far, in truck-sized loads, with most signed delivery notes back', async () => {
    expect(ops.applied).toBe(true);
    expect(ops.loads).toBeGreaterThan(100);
    expect(ops.returns).toBeGreaterThan(ops.loads / 2);
    // Every order due before today is fully loaded; one due today is half loaded.
    const undelivered = await one(
      `select count(*)::text as n from sales_order o
        where o.reverses_id is null and o.delivery_date < $1::date
          and coalesce((select sum(d.volume_l) from delivery d where d.order_id = o.id), 0) <> o.volume_l`,
      [TODAY],
    );
    expect(undelivered).toBe(0);
    expect(await one(`select count(*)::text as n from delivery where load_date > $1::date`, [TODAY])).toBe(0);
  });

  it('leaves the stock believable: nothing negative, cement low, one component just above its threshold', async () => {
    const levels = await getStockLevels(app, owner);
    expect(levels.length).toBeGreaterThanOrEqual(6);
    for (const l of levels) expect(l.status, l.nameFr).not.toBe('short');
    expect(levels.find((l) => l.nameFr === 'Ciment')?.status).toBe('low');
    const gravel = levels.find((l) => l.nameFr === 'Gravette 15/25');
    expect(gravel?.status).toBe('ok');
    expect(gravel?.level).toBeLessThan((gravel?.lowThreshold ?? 0) * 1.5);
  });

  it('buys and receives: payables with their plan, receipts that put the stock in, one purchase still expected', async () => {
    expect(ops.purchases).toBeGreaterThan(60);
    expect(ops.receipts).toBeGreaterThan(50);
    const purchases = await listPurchases(app, owner);
    const expected = purchases.filter((p) => !p.received && p.totalTtcCentimes > 0);
    expect(expected.length).toBeGreaterThan(0);
    expect(purchases.every((p) => p.dueDate >= p.orderDate)).toBe(true);
    // 'Σ plan = TTC' was checked by the database at commit for every one of them.
  });

  it('invoices the delivered orders, issues one credit note, and the statement shows them', async () => {
    expect(ops.invoices).toBeGreaterThan(30);
    const invoices = await listInvoices(app, owner);
    expect(invoices.filter((i) => i.creditNoteOf)).toHaveLength(1);
    expect(invoices.filter((i) => !i.creditNoteOf && i.cancelled)).toHaveLength(1);
    expect(invoices.some((i) => !i.creditNoteOf && i.invoiceDate > i.issueDeadline)).toBe(true);
  });

  it('is idempotent and audited as the system actor', async () => {
    const before = await one('select count(*)::text as n from delivery');
    expect(await seedOperationsScenario(seed, allowed, TODAY)).toMatchObject({ applied: false });
    expect(await one('select count(*)::text as n from delivery')).toBe(before);
    for (const table of ['delivery', 'stock_movement', 'purchase', 'invoice']) {
      expect(
        await one(
          `select count(*)::text as n from audit_event where table_name = $1 and actor_user_id <> '00000000-0000-7000-8000-000000000002'`,
          [table],
        ),
        table,
      ).toBe(0);
    }
    await expect(seedOperationsScenario(seed, { ...allowed, REAL_DATA: true }, TODAY)).rejects.toThrow(
      /REAL_DATA/,
    );
  });
});
