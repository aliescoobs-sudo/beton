import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { recordMoneyView } from '../src/modules/platform-security';
import type { Role } from '../src/modules/platform-security/domain/permissions';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { insertInstrument, insertOrder, moneyMaster, orderMaster } from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// D245 (D-A, migration 0239): each office role reads the money of ITS OWN side and nothing else; the database says so, not only the screens.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const marker = `om_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
let actors = {} as Record<Role, string>;
let done: () => Promise<void>;
let clientId = '';
let supplierId = '';
let orderCode = '';
const as = <T>(role: Role, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: actors[role], role: role as never, requestId: marker }, fn);

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  actors = v.ids;
  done = v.done;
  const m = await orderMaster(app, actors.owner, marker);
  const money = await moneyMaster(app, actors.owner, marker);
  clientId = m.clientId;
  supplierId = money.supplierId;
  // the owner makes one order and one instrument of each direction
  await as('owner', async (tx) => {
    orderCode = (await insertOrder(tx, actors.owner, m)).code;
    await insertInstrument(tx, actors.owner, { direction: 'in', clientId });
    await insertInstrument(tx, actors.owner, { direction: 'out', supplierId });
  });
});
afterAll(async () => {
  await done();
  await app.end();
});

const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' });
/** A table the role cannot read: refused outright (no privilege) or an empty answer (row-level security); never a row. */
const unreadable = async (p: Promise<{ rowCount: number | null }>) => {
  const r = await p.then(
    (x) => x.rowCount,
    (e: { code?: string }) => (e.code === '42501' ? 0 : Promise.reject(e)),
  );
  expect(r).toBe(0);
};

describe('office_sales reads the client side', () => {
  it('reads orders and the incoming instruments of a client, never an outgoing one', async () => {
    const o = await as('office_sales', (tx) =>
      tx.query(`select code from sales_order where client_id = $1`, [clientId]),
    );
    expect(o.rows.map((r) => r.code)).toEqual([orderCode]);
    const i = await as('office_sales', (tx) =>
      tx.query(`select direction from payment_instrument where client_id = $1 or supplier_id = $2`, [
        clientId,
        supplierId,
      ]),
    );
    expect(i.rows.map((r) => r.direction)).toEqual(['in']);
    const e = await as('office_sales', (tx) =>
      tx.query(
        `select count(*)::int n from instrument_event ev join payment_instrument p on p.id = ev.instrument_id where p.supplier_id = $1`,
        [supplierId],
      ),
    );
    expect(e.rows[0].n).toBe(0);
  });

  it('reads no supplier-side, cash, bank or cost table', async () => {
    for (const t of [
      'purchase',
      'purchase_plan_item',
      'supplier_invoice',
      'supplier_invoice_event',
      'money_account',
      'money_movement',
      'opening_balance',
    ])
      expect((await as('office_sales', (tx) => tx.query(`select 1 from "${t}"`))).rowCount, t).toBe(0);
    for (const t of ['cost_rate', 'fuel_norm', 'bl_cost_snapshot', 'price_grid', 'purchase_price'])
      await unreadable(as('office_sales', (tx) => tx.query(`select 1 from "${t}"`)));
    await unreadable(as('office_sales', (tx) => tx.query(`select 1 from finance.finance_entry`)));
    await denied(
      as('office_sales', (tx) =>
        tx.query(`select * from public.margin_summary('month', null, null, null, null, null, null)`),
      ),
    );
  });

  it('may read the payment state of invoices (the same door as the owner)', async () => {
    await expect(
      as('office_sales', (tx) => tx.query(`select * from public.invoice_payment_state()`)),
    ).resolves.toBeTruthy();
  });
});

describe('office_purchases reads the supplier side and the cash', () => {
  it('reads the outgoing instruments of a supplier, never an incoming one', async () => {
    const i = await as('office_purchases', (tx) =>
      tx.query(`select direction from payment_instrument where client_id = $1 or supplier_id = $2`, [
        clientId,
        supplierId,
      ]),
    );
    expect(i.rows.map((r) => r.direction)).toEqual(['out']);
  });

  it('sees the cash accounts only, never a bank account', async () => {
    const { rows } = await as('office_purchases', (tx) =>
      tx.query(`select distinct kind from money_account`),
    );
    expect(rows.map((r) => r.kind)).toEqual(['cash']);
    const mv = await as('office_purchases', (tx) =>
      tx.query(
        `select count(*)::int n from money_movement m join money_account a on a.id = m.account_id where a.kind <> 'cash'`,
      ),
    );
    expect(mv.rows[0].n).toBe(0);
  });

  it('reads no client-side, cost or finance table; the invoice payment state is refused', async () => {
    for (const t of ['sales_order', 'invoice', 'avoir', 'payment_plan_item'])
      expect((await as('office_purchases', (tx) => tx.query(`select 1 from "${t}"`))).rowCount, t).toBe(0);
    for (const t of ['cost_rate', 'fuel_norm', 'bl_cost_snapshot', 'selling_price'])
      await unreadable(as('office_purchases', (tx) => tx.query(`select 1 from "${t}"`)));
    await unreadable(as('office_purchases', (tx) => tx.query(`select 1 from finance.finance_entry`)));
    await denied(as('office_purchases', (tx) => tx.query(`select * from public.invoice_payment_state()`)));
  });
});

describe('both offices', () => {
  it.each(['office_sales', 'office_purchases'] as const)(
    '%s cannot write money tables it reads (no insert, update or delete)',
    async (role) => {
      await denied(as(role, (tx) => tx.query(`update payment_instrument set amount_centimes = 1`)));
      await denied(as(role, (tx) => tx.query(`delete from money_movement`)));
    },
  );

  it.each(['office_sales', 'office_purchases'] as const)(
    'every money view by %s is audited',
    async (role) => {
      const user = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
      await recordMoneyView(app, { id: actors[role], role }, `screen:${marker}-${role}`);
      const { rows } = await as('owner', (tx) =>
        tx.query(`select actor_user_id::text, action from audit_event where table_name = $1`, [
          `screen:${marker}-${role}`,
        ]),
      );
      expect(rows).toEqual([{ actor_user_id: actors[role], action: 'view' }]);
      expect(user.id).toBe(actors.owner);
    },
  );
});
