import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { RLS_TABLES, TABLE_ACCESS } from '../src/modules/platform-security/domain/table-access';
import { recordMoneyView } from '../src/modules/platform-security';
import { testEnv } from './db-env';
import { realActor, realSessionUser, type TestActor } from './helpers/actors';
import {
  allocationScene,
  deliveryScene,
  newDelivery,
  ensureOpening,
  insertInstrument,
  insertMovementReversal,
  insertInvoice,
  insertOrder,
  insertPurchase,
  insertQuote,
  moneyMaster,
  newCashMovement,
  orderMaster,
  purchaseMaster,
} from './helpers/ledger-fixtures';

// DECISIONS 81 (provisional): money visibility enforced by the database. Every table flagged `money` in TABLE_ACCESS
// gives zero rows to partner, office, plant, system and anonymous; the owner and support read; support writes nothing;
// the audit rows of a money table (they hold the amounts) are hidden from everyone but the owner and support.
type MoneyTable = {
  [K in (typeof RLS_TABLES)[number]]: (typeof TABLE_ACCESS)[K] extends { money: true } ? K : never;
}[(typeof RLS_TABLES)[number]];
const MONEY_TABLES = RLS_TABLES.filter((t) => 'money' in TABLE_ACCESS[t]) as MoneyTable[];

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const marker = `money_${randomUUID().replace(/-/g, '')}`;
const actors = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', TestActor>;
const inCtx = <T>(role: string, userId: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId, role: role as never, requestId: marker }, fn);

/** One way to insert a row of each money table as a given actor (typed so a new money table needs a fixture). */
const SEED: Record<MoneyTable, (tx: pg.PoolClient, actor: string) => Promise<unknown>> = {
  purchase_price: async (tx, actor) => {
    const supplier = await tx.query<{ id: string }>(
      `insert into supplier (id, code, name, category) values (gen_random_uuid(), public.next_code('FRN', 2), $1, 'other') returning id`,
      [`mv${marker}${actor}`],
    );
    const component = await tx.query<{ id: string }>(
      `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), public.next_code('CMP', 2), $1, 'x', 'g') returning id`,
      [`mv${marker}${actor}`],
    );
    const unit = await tx.query<{ id: string }>(
      `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 'kg', 1000) returning id`,
      [component.rows[0]?.id],
    );
    return tx.query(
      `insert into purchase_price (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by)
       values (gen_random_uuid(), $1, $2, $3, 100, '2000-01-01', $4)`,
      [component.rows[0]?.id, supplier.rows[0]?.id, unit.rows[0]?.id, actor],
    );
  },
  sales_order: async (tx, actor) => insertOrder(tx, actor, await orderMaster(app, actors.owner.id, marker)),
  payment_plan_item: async (tx, actor) =>
    insertOrder(tx, actor, await orderMaster(app, actors.owner.id, marker)),
  opening_balance: async (tx, actor) => {
    const account = await tx.query<{ id: string }>(
      `insert into money_account (id, kind, label, created_by) values (gen_random_uuid(), 'cash', $1, $2) returning id`,
      [`mv${randomUUID().replace(/-/g, '')}`, actor],
    );
    return tx.query(
      `insert into opening_balance (id, account_id, as_of, amount_centimes, created_by) values (gen_random_uuid(), $1, '2026-01-01', 100, $2)`,
      [account.rows[0]?.id, actor],
    );
  },
  payment_instrument: async (tx, actor) => {
    await moneyMaster(app, actors.owner.id, marker);
    return insertInstrument(tx, actor, {
      clientId: (await orderMaster(app, actors.owner.id, marker)).clientId,
    });
  },
  instrument_event: async (tx, actor) => {
    await moneyMaster(app, actors.owner.id, marker);
    return insertInstrument(tx, actor, {
      clientId: (await orderMaster(app, actors.owner.id, marker)).clientId,
    });
  },
  money_movement: async (tx, actor) => {
    await moneyMaster(app, actors.owner.id, marker);
    const original = await newCashMovement(
      app,
      actors.owner.id,
      marker,
      (await orderMaster(app, actors.owner.id, marker)).clientId,
    );
    return insertMovementReversal(tx, actor, original, `mv ${marker}`);
  },
  opening_party_balance: async (tx, actor) => {
    await ensureOpening(app, actors.owner.id, marker);
    return tx.query(
      `insert into opening_party_balance (id, client_id, amount_centimes, created_by) values (gen_random_uuid(), $1, 100, $2)`,
      [(await orderMaster(app, actors.owner.id, marker)).clientId, actor],
    );
  },
  allocation: async (tx, actor) => {
    const scene = await allocationScene(app, actors.owner.id, marker);
    return tx.query(
      `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by)
       values (gen_random_uuid(), $1, $2, 100, $3)`,
      [scene.instrumentId, scene.itemId, actor],
    );
  },
  alert: (tx, actor) =>
    tx.query(
      `insert into alert (id, rule_id, subject_key, first_detected_on, created_by)
       values (gen_random_uuid(), 'CASH-DEFICIT', $1, current_date, $2)`,
      [`mv${marker}:${actor}`, actor],
    ),
  alert_event: async (tx, actor) => {
    const alert = await tx.query<{ id: string }>(
      `insert into alert (id, rule_id, subject_key, first_detected_on, created_by)
       values (gen_random_uuid(), 'PAY-DUE', $1, current_date, $2) returning id`,
      [`mvev${marker}:${actor}`, actor],
    );
    return tx.query(
      `insert into alert_event (id, alert_id, seq, kind, severity, at_date, created_by)
       values (gen_random_uuid(), $1, 1, 'detected', 'urgent', current_date, $2)`,
      [alert.rows[0]?.id, actor],
    );
  },
  cash_decision: (tx, actor) =>
    tx.query(
      `insert into cash_decision (id, alert_key, option_id, kinds, target_date, coverage_bp, gain_centimes, shortfall_centimes, details, decided_on, created_by)
       values (gen_random_uuid(), $1, 'DEPOSIT-EARLY:x', array['DEPOSIT-EARLY'], current_date, 10000, 100, 100, '{}', current_date, $2)`,
      [`CASH-DEFICIT:mv${marker}`, actor],
    ),
  fuel_purchase: (tx, actor) =>
    tx.query(
      `insert into fuel_purchase (id, purchased_on, litres_ml, total_centimes, created_by)
       values (gen_random_uuid(), '2094-03-03', 1000000, 1234500, $1)`,
      [actor],
    ),
  quote: async (tx, actor) => insertQuote(tx, actor, await orderMaster(app, actors.owner.id, marker)),
  purchase: async (tx, actor) =>
    insertPurchase(tx, actor, await purchaseMaster(app, actors.owner.id, marker)),
  // Lines and plan items are written together with their purchase, by the same actors.
  purchase_line: async (tx, actor) =>
    insertPurchase(tx, actor, await purchaseMaster(app, actors.owner.id, marker)),
  purchase_plan_item: async (tx, actor) =>
    insertPurchase(tx, actor, await purchaseMaster(app, actors.owner.id, marker)),
  // Invoice and lines are written together, by the same actors; each writer invoices a load of its own.
  invoice: async (tx, actor) => {
    const scene = await deliveryScene(app, actors.owner.id, marker);
    const delivery = await newDelivery(app, actors.owner.id, marker, scene, 50, 2098);
    return insertInvoice(tx, actor, scene, delivery, `dl${marker}`);
  },
  invoice_line: async (tx, actor) => {
    const scene = await deliveryScene(app, actors.owner.id, marker);
    const delivery = await newDelivery(app, actors.owner.id, marker, scene, 50, 2098);
    return insertInvoice(tx, actor, scene, delivery, `dl${marker}`);
  },
  selling_price: async (tx, actor) => {
    const type = await tx.query<{ id: string }>(
      `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'V' || upper(substr(md5(random()::text), 1, 8)), $1) returning id`,
      [`mv${marker}${actor}`],
    );
    return tx.query(
      `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
       values (gen_random_uuid(), $1, null, 100, '2000-01-01', $2)`,
      [type.rows[0]?.id, actor],
    );
  },
};

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    actors[role] = await realActor(env.DATABASE_URL_MIGRATOR, role);
  }
  for (const table of MONEY_TABLES)
    await inCtx('owner', actors.owner.id, (tx) => SEED[table](tx, actors.owner.id));
});

describe('the registry', () => {
  it('flags at least the price tables as money', () => {
    expect(MONEY_TABLES).toEqual(expect.arrayContaining(['purchase_price', 'selling_price']));
  });

  it.each(MONEY_TABLES)('%s: only owner and support may read in the registry', (table) => {
    const read = TABLE_ACCESS[table].read;
    expect(read).toMatchObject({
      owner: 'all',
      support: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
    });
  });

  it('audit.is_money_table agrees with the registry, table by table', async () => {
    for (const table of RLS_TABLES) {
      const { rows } = await migrator.query<{ m: boolean }>('select audit.is_money_table($1) as m', [table]);
      expect(rows[0]?.m, table).toBe('money' in TABLE_ACCESS[table]);
    }
  });
});

describe.each(MONEY_TABLES)('money table %s (DECISIONS 81)', (table) => {
  it('gives zero rows to partner, office, plant, system and anonymous', async () => {
    for (const role of ['partner', 'office', 'plant'] as const) {
      const { rows } = await inCtx(role, actors[role].id, (tx) => tx.query(`select 1 from ${table}`));
      expect(rows, role).toEqual([]);
    }
    for (const [role, id] of [
      ['system', '00000000-0000-7000-8000-000000000001'],
      ['anonymous', '00000000-0000-7000-8000-000000000000'],
    ]) {
      const { rows } = await inCtx(role as string, id as string, (tx) => tx.query(`select 1 from ${table}`));
      expect(rows, role).toEqual([]);
    }
    const { rows } = await app.query(`select 1 from ${table}`);
    expect(rows, 'no context').toEqual([]);
  });

  it('is readable by the owner and by support', async () => {
    for (const role of ['owner', 'support'] as const) {
      const { rows } = await inCtx(role, actors[role].id, (tx) => tx.query(`select 1 from ${table}`));
      expect(rows.length, role).toBeGreaterThan(0);
    }
  });

  const blind = (): readonly string[] =>
    'blindWriters' in TABLE_ACCESS[table] ? [...(TABLE_ACCESS[table].blindWriters as readonly string[])] : [];

  it.each(['support', 'partner', 'office', 'plant'] as const)(
    'refuses a write by %s under RLS unless it is a blind writer',
    async (role) => {
      const write = inCtx(role, actors[role].id, (tx) => SEED[table](tx, actors[role].id));
      if (blind().includes(role)) await expect(write).resolves.not.toThrow();
      else await expect(write).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('a blind writer inserts but cannot read the row back, not even with RETURNING', async () => {
    for (const role of blind() as 'office'[]) {
      await expect(
        inCtx(role, actors[role].id, (tx) => tx.query(`select 1 from ${table}`)),
      ).resolves.toMatchObject({
        rows: [],
      });
    }
  });

  it('hides its audit rows (they hold the amounts) from partner, office and plant; owner and support read them', async () => {
    for (const role of ['partner', 'office', 'plant'] as const) {
      const { rows } = await inCtx(role, actors[role].id, (tx) =>
        tx.query(`select 1 from audit_event where table_name = $1`, [table]),
      );
      expect(rows, role).toEqual([]);
    }
    for (const role of ['owner', 'support'] as const) {
      const { rows } = await inCtx(role, actors[role].id, (tx) =>
        tx.query(`select 1 from audit_event where table_name = $1`, [table]),
      );
      expect(rows.length, role).toBeGreaterThan(0);
    }
  });
});

describe('support is read-only everywhere (DECISIONS 81)', () => {
  it('no write policy mentions support, and every readable table has its support read policy', async () => {
    const writes = await migrator.query(
      `select tablename, policyname from pg_policies
        where schemaname = 'public' and cmd <> 'SELECT' and (coalesce(qual, '') || coalesce(with_check, '')) like '%support%'`,
    );
    expect(writes.rows).toEqual([]);
    const missing = await migrator.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and has_table_privilege('belgobeton_app', c.oid, 'SELECT') and c.relname <> 'security_alert_ack'
          and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                            and p.policyname = 'support_read')`,
    );
    expect(missing.rows).toEqual([]);
  });

  it('support reads the audit log and a table of master data, but cannot insert a zone or a parameter', async () => {
    const audit = await inCtx('support', actors.support.id, (tx) =>
      tx.query('select 1 from audit_event limit 1'),
    );
    expect(audit.rows.length).toBe(1);
    await expect(
      inCtx('support', actors.support.id, (tx) =>
        tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 10)`, [marker]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inCtx('support', actors.support.id, (tx) =>
        tx.query(`insert into parameter (key, value, updated_by, updated_at) values ($1, '1', $2, now())`, [
          `test.${marker}`,
          actors.support.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('every view of a money screen by support is audited; the owner is not logged', async () => {
    const support = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'support');
    const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
    await recordMoneyView(app, support, `screen:${marker}`);
    await recordMoneyView(app, owner, `screen:${marker}`);
    const { rows } = await inCtx('owner', actors.owner.id, (tx) =>
      tx.query<{ actor_user_id: string; action: string }>(
        `select actor_user_id::text, action from audit_event where table_name = $1`,
        [`screen:${marker}`],
      ),
    );
    expect(rows).toEqual([{ actor_user_id: support.id, action: 'view' }]);
  });

  it('a disabled support account is refused by the database at once (the owner can disable it at any time)', async () => {
    const fresh = uuidv7(realClock.now());
    await migrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
       values ($1, 'Support off', $2, true, 'support', 'fr', 'active', true, now())`,
      [fresh, `off-${marker}@belgobeton.test`],
    );
    await expect(
      inCtx('support', fresh, (tx) => tx.query('select 1 from purchase_price limit 1')),
    ).resolves.toBeTruthy();
    await migrator.query(`update "user" set status = 'disabled' where id = $1`, [fresh]);
    await expect(
      inCtx('support', fresh, (tx) => tx.query('select 1 from purchase_price limit 1')),
    ).rejects.toThrow(/does not match/);
  });
});
