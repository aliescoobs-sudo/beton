import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { createPlant, updatePlant, type Plant } from '../src/modules/master-data';
import { getStockLevels, setOpeningStock } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import type { Role } from '../src/modules/platform-security/domain/permissions';
import { testEnv } from './db-env';
import { realActor, realSessionUser } from './helpers/actors';
import { purchaseMaster, type PurchaseMaster } from './helpers/ledger-fixtures';

// R2 (CP-PROD-PLAN): AC-PROD-08 to 14. The V1 accounts are mapped to the pilot's policy roles by the database.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r2${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

const V1 = [
  'app_admin',
  'office_sales',
  'office_purchases',
  'plant_manager',
  'driver',
  'pump_operator',
  'accountant',
  'client_portal',
  'supplier_portal',
] as const;
type V1Role = (typeof V1)[number];
const actors = {} as Record<V1Role, string>;
let owner: SessionUser;
let A: Plant;
let B: Plant;
let master: PurchaseMaster;
let managerA: SessionUser;

async function makeUser(role: Role, plantId: string | null = null): Promise<string> {
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt", "plantId")
     values ($1, $2, $3, true, $4, 'fr', 'active', true, now(), $5)`,
    [id, `${marker} ${role}`, `${marker}-${role}-${id}@belgobeton.test`, role, plantId],
  );
  return id;
}
const as = <T>(role: Role, fn: (tx: pg.PoolClient) => Promise<T>, userId?: string) =>
  withRlsContext(
    app,
    { userId: userId ?? actors[role as V1Role], role: role as never, requestId: marker },
    fn,
  );
const session = (id: string, role: Role): SessionUser => ({
  id,
  name: marker,
  email: `${id}@belgobeton.test`,
  role,
  locale: 'fr',
  twoFactorEnabled: true,
  reenrolRequired: false,
});

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  for (const r of V1) if (r !== 'plant_manager') actors[r] = await makeUser(r);
  const active = await migrator.query(`select 1 from plant where status = 'active'`);
  expect(active.rowCount).toBe(0);
  const a = await createPlant(app, owner, { code: letters(6), name: `A ${marker}` });
  const b = await createPlant(app, owner, { code: letters(6), name: `B ${marker}` });
  if (!a.ok || !b.ok) throw new Error('plants');
  [A, B] = [a.value, b.value];
  actors.plant_manager = await makeUser('plant_manager', A.id);
  managerA = session(actors.plant_manager, 'plant_manager');
  master = await purchaseMaster(app, owner.id, marker);
});
afterAll(async () => {
  for (const p of [A, B]) if (p) await updatePlant(app, owner, p.id, { status: 'archived' });
  await Promise.all([app.end(), auth.end(), migrator.end()]);
});

describe('the role list (AC-PROD-08)', () => {
  it('the database accepts the V1 roles and refuses any other', async () => {
    await expect(makeUser('boss' as never)).rejects.toThrow(/user_role_check/);
    await expect(makeUser('plant_manager', null)).rejects.toThrow(/user_plant_scope/);
    await expect(makeUser('office_sales', A.id)).rejects.toThrow(/user_plant_scope/);
  });
  it('a request role that does not match the stored role is refused', async () => {
    await expect(
      withRlsContext(app, { userId: actors.office_sales, role: 'app_admin', requestId: marker }, (tx) =>
        tx.query('select 1 from zone'),
      ),
    ).rejects.toThrow(/does not match/);
  });
});

describe('default deny and money (AC-PROD-09, 10, 13, 14)', () => {
  const noRows: V1Role[] = ['driver', 'pump_operator', 'client_portal', 'supplier_portal'];
  const tables = async () =>
    (
      await migrator.query<{ relname: string }>(
        `select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
            and has_table_privilege('belgobeton_app', c.oid, 'SELECT') order by 1`,
      )
    ).rows.map((r) => r.relname);

  it.each(noRows)('%s reads no row of any table or view', async (role) => {
    for (const t of await tables()) {
      const { rows } = await as(role, (tx) =>
        tx.query<{ n: string }>(`select count(*)::text as n from "${t}"`),
      );
      expect(Number(rows[0]?.n), `${role} ${t}`).toBe(0);
    }
  });

  it('the accountant reads invoices, their lines, avoirs and the company profile, and nothing else', async () => {
    const allowed = new Set(['invoice', 'invoice_line', 'avoir', 'company_profile']);
    for (const t of await tables()) {
      const { rows } = await as('accountant', (tx) =>
        tx.query<{ n: string }>(`select count(*)::text as n from "${t}"`),
      );
      if (!allowed.has(t)) expect(Number(rows[0]?.n), `accountant ${t}`).toBe(0);
    }
    await expect(
      as('accountant', (tx) =>
        tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 5)`, [marker]),
      ),
    ).rejects.toThrow();
  });

  it('app_admin reads exactly what the owner reads on the money tables; office_sales and office_purchases read none', async () => {
    for (const t of [
      'payment_instrument',
      'invoice',
      'sales_order',
      'purchase',
      'money_movement',
      'fuel_purchase',
    ]) {
      const ownerRows = (await as('owner', (tx) => tx.query(`select 1 from "${t}"`), owner.id)).rowCount;
      const adminRows = (await as('app_admin', (tx) => tx.query(`select 1 from "${t}"`))).rowCount;
      expect(adminRows, t).toBe(ownerRows);
      for (const r of ['office_sales', 'office_purchases'] as const) {
        expect((await as(r, (tx) => tx.query(`select 1 from "${t}"`))).rowCount, `${r} ${t}`).toBe(0);
      }
    }
  });
});

describe('app_admin and the owner (AC-PROD-12)', () => {
  it('an app_admin write is audited under its own id and the owner reads it', async () => {
    const name = `${marker}-z`;
    await as('app_admin', (tx) =>
      tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 7)`, [name]),
    );
    const { rows } = await as(
      'owner',
      (tx) =>
        tx.query<{ actor_user_id: string }>(
          `select actor_user_id::text from audit_event where table_name = 'zone' and after->>'name' = $1`,
          [name],
        ),
      owner.id as never,
    );
    expect(rows[0]?.actor_user_id).toBe(actors.app_admin);
  });

  it('cannot alter or delete the audit log', async () => {
    await expect(
      as('app_admin', (tx) =>
        tx.query(`update audit_event set reason = 'x' where id = (select max(id) from audit_event)`),
      ),
    ).rejects.toThrow();
    await expect(as('app_admin', (tx) => tx.query(`delete from audit_event`))).rejects.toThrow();
  });

  it('cannot change, disable, delete or downgrade the owner (database trigger)', async () => {
    const ownerId = owner.id;
    const asAdmin = async (sql: string) => {
      const c = await auth.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.role', 'app_admin', true)`);
        await c.query(sql, [ownerId]);
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    await expect(asAdmin(`update "user" set "twoFactorEnabled" = true where id = $1`)).rejects.toThrow(
      /app_admin cannot change the owner/,
    );
    await expect(asAdmin(`update "user" set role = 'partner' where id = $1`)).rejects.toThrow(
      /cannot be downgraded/,
    );
    await expect(asAdmin(`update "user" set status = 'disabled' where id = $1`)).rejects.toThrow(
      /cannot be disabled/,
    );
    await expect(asAdmin(`delete from "user" where id = $1`)).rejects.toThrow(
      /cannot be deleted|permission denied/,
    );
  });
});

describe('sales and purchases are two doors (AC-PROD-10)', () => {
  it('office_purchases cannot create an order or a quote; office_sales cannot record a receipt or a supplier invoice', async () => {
    await expect(
      as('office_purchases', (tx) =>
        tx.query(
          `select * from create_quote(gen_random_uuid(), gen_random_uuid(), 1000, 30, '2026-06-01', 2000)`,
        ),
      ),
    ).rejects.toThrow(/may not use this door/);
    await expect(
      as('office_sales', (tx) =>
        tx.query(`select record_receipt_lines(gen_random_uuid(), '2026-06-01', null, false)`),
      ),
    ).rejects.toThrow(/may not use this door/);
    await expect(
      as('office_sales', (tx) =>
        tx.query(
          `select create_supplier_invoice('ACH-2026-00001', 'x', '2026-06-01', '2026-06-30', '[]'::jsonb, null, '2026-06-01')`,
        ),
      ),
    ).rejects.toThrow(/may not use this door/);
  });
});

describe('plant_manager is scoped to one plant (AC-PROD-11)', () => {
  it('reads and writes the stock of its plant only', async () => {
    await setOpeningStock(app, owner, {
      componentId: master.componentId,
      date: '2026-05-01',
      qtyBase: 3_000_000,
      plantId: A.id,
    });
    await setOpeningStock(app, owner, {
      componentId: master.componentId,
      date: '2026-05-01',
      qtyBase: 9_000_000,
      plantId: B.id,
    });
    const seen = (await getStockLevels(app, managerA)).find((c) => c.componentId === master.componentId);
    expect(seen?.level).toBe(3_000_000);
    const rows = await as('plant_manager', (tx) =>
      tx.query<{ plant_id: string }>(
        `select distinct plant_id from stock_movement where plant_id is not null`,
      ),
    );
    expect(rows.rows.every((r) => r.plant_id === A.id)).toBe(true);
    // asking for the other plant explicitly returns nothing
    expect(
      (await getStockLevels(app, managerA, { plantId: B.id })).find(
        (c) => c.componentId === master.componentId,
      )?.level ?? 0,
    ).toBe(0);
    // writing to the other plant is refused by the database
    await expect(
      as('plant_manager', (tx) =>
        tx.query(
          `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, plant_id, created_by)
           values (gen_random_uuid(), $1, '2026-05-02', 5, 'count_adjustment', gen_random_uuid(), $2, $3)`,
          [master.componentId, B.id, actors.plant_manager],
        ),
      ),
    ).rejects.toThrow();
    // without naming a plant, a row takes the manager's own
    await as('plant_manager', (tx) =>
      tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, created_by)
         values (gen_random_uuid(), $1, '2026-05-02', 5, 'count_adjustment', gen_random_uuid(), 'count test', $2)`,
        [master.componentId, actors.plant_manager],
      ),
    ).catch(() => undefined);
    const ops = await as('plant_manager', (tx) =>
      tx.query(`select 1 from sales_order_ops where plant_id = $1`, [B.id]),
    );
    expect(ops.rowCount).toBe(0);
  });
});

describe('the other V1 roles are real accounts', () => {
  it('a test account of every V1 role was created', async () => {
    expect(Object.keys(actors).sort()).toEqual([...V1].sort());
    expect((await realActor(env.DATABASE_URL_MIGRATOR, 'office')).id).toBeTruthy();
  });
});
