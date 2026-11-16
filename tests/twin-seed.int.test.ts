import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_TEST_DATABASE, ensureRoles, recreateDatabase } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { seedTraining } from '../scripts/seed-training';
import { seedTwin } from '../scripts/seed/twin/index';
import {
  getAging,
  getCashForecast,
  getCashPosition,
  listCharges,
  listPaymentApprovals,
} from '../src/modules/ledger';
import { inRequest } from '../src/modules/platform-security';
import { getFuelTankLevels, loadFuelCheck } from '../src/modules/operations';
import { realSessionUser } from './helpers/actors';
import { testEnv } from './db-env';

// T20 (D251): the fictitious twin seed, run once on a scratch database that the training seed (profile twin-base) prepared. Fictitious data only.
const env = testEnv(TRAINING_TEST_DATABASE);
const training = { ...env, TRAINING_MODE: true as const, APP_ENV: 'training' as const };
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
migrator.on('error', () => undefined);
let first: Awaited<ReturnType<typeof seedTwin>>;
let second: Awaited<ReturnType<typeof seedTwin>>;
/** A snapshot of every table's row count: a second run must leave it exactly as it was. */
let afterFirst: Record<string, number>;
let afterSecond: Record<string, number>;

async function rowCounts(): Promise<Record<string, number>> {
  const tables = await migrator.query<{ s: string; t: string }>(
    `select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'finance', 'history') order by 1, 2`,
  );
  const out: Record<string, number> = {};
  for (const { s, t } of tables.rows)
    out[`${s}.${t}`] = Number(
      (await migrator.query<{ n: string }>(`select count(*) as n from "${s}"."${t}"`)).rows[0]!.n,
    );
  return out;
}

beforeAll(async () => {
  await ensureRoles(training, env.DATABASE_URL_SEED);
  await recreateDatabase(training, TRAINING_TEST_DATABASE);
  await runMigrations(env.DATABASE_URL_MIGRATOR);
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-twin-'));
  await seedTraining({
    provenance: 'unverified-test-database',
    profile: 'twin-base',
    env: training,
    today: '2026-11-15',
    credentialsFile: path.join(dir, 'training-accounts.local.txt'),
  });
  first = await seedTwin({ env: training, flag: 'true' });
  afterFirst = await rowCounts();
  second = await seedTwin({ env: training, flag: 'true' });
  afterSecond = await rowCounts();
}, 900_000);
afterAll(() => migrator.end());

const count = async (sql: string, params: unknown[] = []) =>
  Number((await migrator.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('the twin seed refuses (T20)', () => {
  it('without the fictitious flag, on a production-looking environment, and without the marker row', async () => {
    await expect(seedTwin({ env: training, flag: undefined })).rejects.toThrow(/TWIN_SEED_FICTITIOUS/);
    await expect(
      seedTwin({ env: { ...training, APP_ENV: 'production' as never }, flag: 'true' }),
    ).rejects.toThrow(/production/);
    await expect(seedTwin({ env: { ...training, REAL_DATA: true }, flag: 'true' })).rejects.toThrow(
      /REAL_DATA/,
    );
    await expect(
      seedTwin({
        env: {
          ...training,
          DATABASE_URL_MIGRATOR: training.DATABASE_URL_MIGRATOR.replace(
            TRAINING_TEST_DATABASE,
            'kayas_production',
          ),
        },
        flag: 'true',
      }),
    ).rejects.toThrow(/production/);
    // no marker row: the training marker is taken away for one call and put back
    await migrator.query('delete from public.training_marker');
    try {
      await expect(seedTwin({ env: training, flag: 'true' })).rejects.toThrow(/fictitious marker/);
    } finally {
      await migrator.query('insert into public.training_marker default values');
    }
  });
});

describe('item 1: the structure', () => {
  it('seeds and is idempotent: the second run changes nothing', () => {
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst['public.twin_seed_marker']).toBe(1);
  });

  it('has two plants, about 30 clients, 12 suppliers, vehicles and pumps', async () => {
    expect(await count(`select count(*) as n from plant where status = 'active'`)).toBe(2);
    expect(await count(`select count(*) as n from client where status = 'active'`)).toBe(30);
    expect(await count(`select count(*) as n from supplier where status = 'active'`)).toBe(12);
    expect(await count(`select count(*) as n from truck where kind = 'mixer'`)).toBe(9);
    expect(await count(`select count(*) as n from truck where kind = 'pump'`)).toBe(3);
  });

  it('mixes companies and private individuals, PO-required and TTC clients, aliases, names in different cases', async () => {
    expect(await count(`select count(*) as n from client where kind = 'person'`)).toBeGreaterThanOrEqual(6);
    expect(await count(`select count(*) as n from client where kind = 'company'`)).toBeGreaterThanOrEqual(20);
    expect(await count(`select count(*) as n from client where po_required`)).toBeGreaterThanOrEqual(5);
    expect(await count(`select count(*) as n from client where price_basis = 'TTC'`)).toBeGreaterThanOrEqual(
      8,
    );
    expect(await count(`select count(*) as n from client where price_basis = 'HT'`)).toBeGreaterThanOrEqual(
      15,
    );
    expect(await count(`select count(*) as n from client_alias`)).toBeGreaterThanOrEqual(5);
    expect(
      await count(
        `select count(*) as n from client where split_part(name, ' (', 1) = upper(split_part(name, ' (', 1))`,
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await count(
        `select count(*) as n from client where split_part(name, ' (', 1) = lower(split_part(name, ' (', 1))`,
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it('has the A1 recipes per class and plant', async () => {
    expect(await count(`select count(*) as n from recette where plant_id is not null`)).toBe(2);
    expect(
      await count(
        `select count(distinct concrete_type_id) as n from recette r join concrete_type t on t.id = r.concrete_type_id where t.code in ('B15','B20','B25','B30','B35')`,
      ),
    ).toBe(5);
  });
});

describe('item 2: the sales history', () => {
  it('has the orders of 1 Sep to 15 Nov in both plants, cancellations as reversing rows, pump jobs and PO numbers', async () => {
    expect(await count(`select count(*) as n from sales_order where reverses_id is null`)).toBeGreaterThan(
      380,
    );
    expect(
      await count(`select count(*) as n from sales_order where reverses_id is not null`),
    ).toBeGreaterThanOrEqual(3);
    expect(
      await count(
        `select count(*) as n from sales_order where reverses_id is null and order_date < '2026-09-01'`,
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*) as n from sales_order where reverses_id is null and order_date > '2026-11-15'`,
      ),
    ).toBe(0);
    for (const code of ['TETOUAN', 'CHEFCHN'])
      expect(
        await count(
          `select count(*) as n from sales_order o join plant p on p.id = o.plant_id where p.code = $1 and o.reverses_id is null`,
          [code],
        ),
      ).toBeGreaterThan(100);
    expect(await count(`select count(*) as n from pump_job`)).toBeGreaterThan(30);
    expect(
      await count(
        `select count(*) as n from sales_order where discharge_method = 'GOULOTTE' and reverses_id is null`,
      ),
    ).toBeGreaterThan(200);
    expect(
      await count(
        `select count(*) as n from sales_order where discharge_method = 'POMPE' and reverses_id is null`,
      ),
    ).toBeGreaterThan(30);
    // every order of a client that requires a PO number carries one
    expect(
      await count(
        `select count(*) as n from sales_order o join client c on c.id = o.client_id left join order_extra x on x.order_id = o.id
          where c.po_required and o.reverses_id is null and x.client_po is null`,
      ),
    ).toBe(0);
  });

  it('numbers the BLs in one run, losing about 12 numbers per plant-month and nothing else', async () => {
    const { rows } = await migrator.query<{ n: number; plant: string; month: string }>(
      `select substr(d.bl_no, 9)::int as n, p.code as plant, to_char(d.load_date, 'YYYY-MM') as month
         from delivery d join sales_order o on o.id = d.order_id join plant p on p.id = o.plant_id
        where d.reverses_id is null order by 1`,
    );
    expect(rows.length).toBeGreaterThan(1200);
    expect(rows[0]!.n).toBe(1);
    const missing = new Map<string, number>();
    for (const [i, r] of rows.entries()) {
      if (i === 0) continue;
      // every missing number is charged to the plant-month of the BL that follows it
      for (let m = rows[i - 1]!.n + 1; m < r.n; m++)
        missing.set(`${r.plant}|${r.month}`, (missing.get(`${r.plant}|${r.month}`) ?? 0) + 1);
    }
    for (const plant of ['TETOUAN', 'CHEFCHN']) {
      expect(missing.get(`${plant}|2026-09`)).toBe(12);
      expect(missing.get(`${plant}|2026-10`)).toBe(12);
      expect(missing.get(`${plant}|2026-11`)).toBe(6);
    }
    expect([...missing.values()].reduce((a, b) => a + b, 0)).toBe(60);
    // the loads are in business-date order: a later number never has an earlier load date
    const dates = (
      await migrator.query<{ d: string }>(
        `select to_char(load_date, 'YYYY-MM-DD') as d from delivery where reverses_id is null order by bl_no`,
      )
    ).rows.map((r) => r.d);
    expect(dates).toEqual([...dates].sort());
  });

  it("has the plants' paper books with 4 duplicated numbers, the missing numbers and one date typed as text", async () => {
    const { rows } = await migrator.query<{
      plant: string;
      month: string;
      n: number;
      text: boolean;
      mode: string;
    }>(
      `select p.code as plant, to_char(d.delivery_date, 'YYYY-MM') as month, d.bl_raw::int as n, (d.legacy->>'date_cell' = 'text') as text, d.pump_mode as mode
         from history.delivery d join plant p on p.id = d.plant_id order by p.code, d.src_file, d.src_row`,
    );
    let duplicates = 0;
    const missing = new Map<string, number>();
    for (const [i, r] of rows.entries()) {
      const prev = rows[i - 1];
      if (!prev || prev.plant !== r.plant) continue;
      if (r.n === prev.n) duplicates += 1;
      else {
        expect(r.n - prev.n).toBeGreaterThanOrEqual(1);
        expect(r.n - prev.n).toBeLessThanOrEqual(2);
        if (r.n - prev.n === 2)
          missing.set(`${r.plant}|${r.month}`, (missing.get(`${r.plant}|${r.month}`) ?? 0) + 1);
      }
    }
    expect(duplicates).toBe(4);
    expect(rows.filter((r) => r.text)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.mode))).toEqual(new Set(['pump', 'chute', 'unknown']));
    for (const plant of ['TETOUAN', 'CHEFCHN']) {
      expect(missing.get(`${plant}|2026-09`)).toBeGreaterThanOrEqual(9);
      expect(missing.get(`${plant}|2026-09`)).toBeLessThanOrEqual(13);
    }
    expect(await count(`select count(*) as n from history.batch where status = 'applied'`)).toBe(2);
  });

  it('has invoices and an uninvoiced queue, complete cost snapshots, signed BLs back for most loads', async () => {
    expect(await count(`select count(*) as n from invoice where credit_note_of is null`)).toBeGreaterThan(
      300,
    );
    expect(
      await count(`select count(*) as n from invoice where credit_note_of is not null`),
    ).toBeGreaterThanOrEqual(2);
    expect(await count(`select count(*) as n from bl_cost_snapshot where incomplete`)).toBe(0);
    expect(await count(`select count(*) as n from delivery_return`)).toBeGreaterThan(900);
    expect(
      await count(
        `select count(*) as n from delivery d where d.reverses_id is null and not exists (select 1 from delivery_delivered g where g.delivery_id = d.id)`,
      ),
    ).toBeGreaterThan(0);
  });
});

describe('item 4: stock, receipts, fuel and counts', () => {
  it('never lets a component of a plant go below zero on any day, from the opening stock on', async () => {
    const lows = await migrator.query<{
      plant_id: string;
      component_id: string;
      movement_date: string;
      lvl: string;
    }>(
      `select plant_id, component_id, movement_date, lvl from (
         select plant_id, component_id, movement_date, sum(sum(qty_base)) over (partition by plant_id, component_id order by movement_date) lvl
           from stock_movement group by plant_id, component_id, movement_date) x where lvl < 0`,
    );
    expect(lows.rows).toEqual([]);
    expect(await count(`select count(*) as n from stock_movement where source = 'opening'`)).toBe(12);
    // consumption comes from the BLs (the stock engine), not from the seed
    expect(
      await count(`select count(*) as n from stock_movement where source = 'delivery' and qty_base < 0`),
    ).toBeGreaterThan(8000);
  });

  it('has purchases received, some still on their way, three arrivals counted short, and thresholds', async () => {
    expect(await count(`select count(*) as n from purchase where reverses_id is null`)).toBeGreaterThan(90);
    expect(await count(`select count(*) as n from purchase_receipt`)).toBeGreaterThan(80);
    expect(
      await count(
        `select count(*) as n from purchase p where p.reverses_id is null and not exists (select 1 from purchase_receipt r where r.purchase_id = p.id)`,
      ),
    ).toBeGreaterThan(10);
    expect(await count(`select count(*) as n from stock_threshold`)).toBe(12);
    expect(await count(`select count(*) as n from receipt_variance`)).toBeGreaterThanOrEqual(1);
  });

  it('has a count round with small variances posted and two outside the tolerance waiting for a decision', async () => {
    expect(await count(`select count(*) as n from stock_count`)).toBe(12);
    expect(await count(`select count(*) as n from stock_count where status = 'pending_decision'`)).toBe(2);
    expect(
      await count(
        `select count(*) as n from stock_count where status = 'in_tolerance_posted' and variance_qty <> 0`,
      ),
    ).toBeGreaterThanOrEqual(5);
    expect(
      await count(
        `select count(*) as n from stock_count where abs(coalesce(variance_bp, 0)) > 300 and status = 'in_tolerance_posted'`,
      ),
    ).toBe(0);
  });

  it('has fuel: tank openings, purchases and fills, and ONE truck-month the fuel check flags', async () => {
    const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
    const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
    try {
      const check = await loadFuelCheck(app, owner, { from: '2026-09-01', to: '2026-11-30', plantId: null });
      expect(check.ok).toBe(true);
      const rows = check.ok ? check.value : [];
      const mixers = rows.filter((r) => r.truckKind === 'mixer');
      expect(mixers.length).toBeGreaterThanOrEqual(24);
      const flagged = mixers.filter((r) => r.flagged);
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ truckCode: 'T2', month: '2026-10' });
      // everything else is within a few per cent of the norm
      for (const r of mixers.filter((x) => !x.flagged && x.varianceBp !== null))
        expect(Math.abs(r.varianceBp as number)).toBeLessThan(1000);
      const tanks = await getFuelTankLevels(app, owner);
      expect(tanks).toHaveLength(2);
      for (const t of tanks) expect(t.purchasedL).toBeGreaterThan(5000);
    } finally {
      await app.end();
    }
    expect(await count(`select count(*) as n from fuel_fill`)).toBeGreaterThan(150);
  });
});

describe('item 3: the money', () => {
  const withOwner = async <T>(
    fn: (app: pg.Pool, owner: Awaited<ReturnType<typeof realSessionUser>>) => Promise<T>,
  ): Promise<T> => {
    const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
    const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
    try {
      return await fn(app, owner);
    } finally {
      await app.end();
    }
  };

  it('has payments by cash, cheque, LCN and transfer from clients, and cheques, LCN and transfers to suppliers', async () => {
    for (const method of ['cash', 'cheque', 'lcn', 'transfer'])
      expect(
        await count(`select count(*) as n from payment_instrument where direction = 'in' and method = $1`, [
          method,
        ]),
      ).toBeGreaterThan(5);
    for (const method of ['cheque', 'lcn', 'transfer'])
      expect(
        await count(`select count(*) as n from payment_instrument where direction = 'out' and method = $1`, [
          method,
        ]),
      ).toBeGreaterThan(5);
    // advances and instalments: plan items of those methods are covered
    expect(
      await count(
        `select count(*) as n from payment_plan_item i where i.method = 'advance' and exists (select 1 from allocation a where a.payment_plan_item_id = i.id)`,
      ),
    ).toBeGreaterThan(5);
    expect(
      await count(
        `select count(*) as n from payment_plan_item i where i.method = 'installment' and exists (select 1 from allocation a where a.payment_plan_item_id = i.id)`,
      ),
    ).toBeGreaterThan(5);
  });

  it('has one bounced cheque, one credit nobody allocated, and issued paper with written and due dates', async () => {
    expect(await count(`select count(*) as n from instrument_event where event = 'bounced'`)).toBe(1);
    expect(
      await count(
        `select count(*) as n from payment_instrument i where i.direction = 'in' and not exists (select 1 from allocation a where a.instrument_id = i.id)`,
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*) as n from payment_instrument where direction = 'out' and method in ('cheque', 'lcn') and written_date is not null and due_date is not null and due_date >= written_date`,
      ),
    ).toBeGreaterThan(20);
  });

  it('spreads client balances over the aging buckets and has cheques due in the next 1 to 10 days', async () => {
    await withOwner(async (app, owner) => {
      const clients = await getAging(app, owner, 'client', { today: '2026-11-15' });
      expect(clients.total.current).toBeGreaterThan(0);
      expect(clients.total.d1_30).toBeGreaterThan(0);
      expect(clients.total.d31_60).toBeGreaterThan(0);
      expect(clients.parties.length).toBeGreaterThanOrEqual(15);
      const suppliers = await getAging(app, owner, 'supplier', { today: '2026-11-15' });
      expect(suppliers.total.current + suppliers.total.d1_30 + suppliers.total.d31_60).toBeGreaterThan(0);
      const forecast = await getCashForecast(app, owner, { today: '2026-11-15' });
      const soon = forecast.items.filter(
        (i) => i.side === 'in' && i.dueDate >= '2026-11-16' && i.dueDate <= '2026-11-25',
      );
      expect(soon.length).toBeGreaterThanOrEqual(5);
      expect(forecast.items.filter((i) => i.side === 'out').length).toBeGreaterThan(5);
    });
  });

  it('has one outgoing payment above the upper limit in the owner approvals inbox, and one in the middle band', async () => {
    await withOwner(async (app, owner) => {
      const inbox = await listPaymentApprovals(app, owner);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.amountCentimes).toBeGreaterThan(500_000);
    });
    expect(await count(`select count(*) as n from outgoing_payment_request`)).toBe(2);
  });

  it('has charges with and without a supporting document, small ones paid', async () => {
    expect(await count(`select count(*) as n from charge where document_ref is null`)).toBeGreaterThanOrEqual(
      3,
    );
    expect(
      await count(`select count(*) as n from charge where document_ref is not null`),
    ).toBeGreaterThanOrEqual(8);
    await withOwner(async (app, owner) => {
      const list = await listCharges(app, owner, {
        from: '2026-08-01',
        to: '2026-11-30',
        limit: 100,
      } as never);
      expect(JSON.stringify(list).length).toBeGreaterThan(500);
    });
  });

  it('never lets a cash or bank account go below zero, on any day', async () => {
    await withOwner(async (app, owner) => {
      const position = await getCashPosition(app, owner);
      for (const a of position.accounts) expect(Number(a.real)).toBeGreaterThanOrEqual(0);
      const lows = await inRequest(app, owner, (tx) =>
        tx.query(
          `select m.account_id, m.movement_date, o.amount_centimes + sum(sum(m.amount_centimes)) over (partition by m.account_id order by m.movement_date) as run
             from money_movement m join opening_balance o on o.account_id = m.account_id group by m.account_id, m.movement_date, o.amount_centimes`,
        ),
      );
      expect(lows.rows.filter((r) => Number(r.run) < 0)).toEqual([]);
    });
  });
});
