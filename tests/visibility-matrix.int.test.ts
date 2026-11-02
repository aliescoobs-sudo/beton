import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { USER_ROLES, type Role } from '../src/modules/platform-security/domain/permissions';
import { TABLE_ACCESS } from '../src/modules/platform-security/domain/table-access';
import { VISIBILITY_MATRIX } from '../src/modules/platform-security/domain/visibility-matrix';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// §16.1: the "balances and aggregates" column of the matrix, proved in the database. A role that only enters or prints
// reads zero rows of every money table, and the doors that give a figure refuse it.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await app.end();
});
const marker = `vm_${randomUUID().replace(/-/g, '')}`;
let actors = {} as Record<Role, string>;
const as = <T>(role: Role, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: actors[role], role: role as never, requestId: marker }, fn);

const balanceRoles = new Set<Role>(VISIBILITY_MATRIX.flatMap((r) => r.balances));
const MONEY = (Object.entries(TABLE_ACCESS) as [string, { money?: boolean }][])
  .filter(([, v]) => v.money)
  .map(([k]) => k);
// the accountant has explicit read policies on invoices (D129); the matrix gives it documents and exports, not balances
const ACCOUNTANT_TABLES = new Set(['invoice', 'invoice_line', 'avoir']);

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  actors = v.ids;
  done = v.done;
});

describe('balances and aggregates (§16.1)', () => {
  const others = USER_ROLES.filter((r) => !balanceRoles.has(r) && r !== 'partner');
  it('the matrix names only owner, app_admin and support for balances', () => {
    expect([...balanceRoles].sort()).toEqual(['app_admin', 'owner', 'support']);
  });
  it.each(others)('%s reads zero rows of every money table (accountant: invoices only)', async (role) => {
    for (const t of MONEY) {
      if (role === 'accountant' && ACCOUNTANT_TABLES.has(t)) continue;
      const { rows } = await as(role, (tx) => tx.query(`select 1 from public."${t}" limit 1`)).catch(() => ({
        rows: [] as unknown[],
      }));
      expect(rows, `${role} on ${t}`).toEqual([]);
    }
  });
  it.each(others)('%s is refused the approvals and the cash doors', async (role) => {
    for (const q of ['select * from public.approvals_pending()']) {
      await expect(
        as(role, (tx) => tx.query(q)),
        `${role}: ${q}`,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('the two offices read a client standing as two flags and no figure', async () => {
    for (const role of ['office_sales', 'office_purchases'] as const) {
      const { fields } = await as(role, (tx) =>
        tx.query(`select * from public.client_balance_status(current_date)`),
      );
      expect(fields.map((f) => f.name).sort()).toEqual(['client_code', 'client_id', 'late', 'owes']);
    }
  });
});

describe('reference prices (§16.1, §3)', () => {
  it.each(['owner', 'app_admin', 'office_sales', 'office_purchases', 'plant_manager', 'support'] as const)(
    '%s may read them',
    async (role) => {
      const { fields } = await as(role, (tx) =>
        tx.query(`select * from public.reference_prices(current_date)`),
      );
      expect(fields.map((f) => f.name)).toEqual(['kind', 'item_code', 'item_name', 'price_centimes']);
    },
  );
  it.each(['driver', 'pump_operator', 'accountant', 'client_portal', 'supplier_portal'] as const)(
    '%s is refused',
    async (role) => {
      await expect(
        as(role, (tx) => tx.query(`select * from public.reference_prices(current_date)`)),
      ).rejects.toMatchObject({
        code: '42501',
      });
    },
  );
});
