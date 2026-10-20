import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { seedPilotMasterData } from '../src/modules/master-data';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => Promise.all([system.end(), app.end()]));

// FORCE RLS applies to the table owner too, so reads go through an owner request context.
const asOwner = async <T>(fn: (tx: pg.PoolClient) => Promise<T>) => {
  const owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  return withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'test' }, fn);
};
const allowed = { SIMULATION_ENABLED: true, REAL_DATA: false, NODE_ENV: 'test' };

const counts = () =>
  asOwner((tx) =>
    tx.query<{ n: string }>(
      `select (select count(*) from component) + (select count(*) from purchase_unit)
            + (select count(*) from concrete_type) as n`,
    ),
  ).then((r) => Number(r.rows[0]?.n));
const sequence = () =>
  asOwner((tx) => tx.query(`select last_value from code_sequence where key = 'CMP'`)).then((r) => r.rows);

describe('pilot master-data seed (decision 79)', () => {
  it('was applied by the test setup: 6 components, 7 purchase units, 4 concrete types', async () => {
    expect(await counts()).toBeGreaterThanOrEqual(17);
    const { rows } = await asOwner((tx) => tx.query(`select code from component order by code limit 6`));
    expect(rows.map((r) => r.code)).toEqual(['CMP-01', 'CMP-02', 'CMP-03', 'CMP-04', 'CMP-05', 'CMP-06']);
  });

  it('is idempotent: a second run adds no row and burns no code', async () => {
    const before = await counts();
    const seq = await sequence();
    await seedPilotMasterData(system, allowed);
    expect(await counts()).toBe(before);
    expect(await sequence()).toEqual(seq);
    expect(seq).toEqual([{ last_value: expect.anything() }]);
  });

  it('audits every seeded row as the system actor with request id "seed"', async () => {
    const { rows } = await asOwner((tx) =>
      tx.query<{ table_name: string; n: string }>(
        `select table_name, count(*) as n from audit_event
        where actor_user_id = $1 and actor_kind = 'system' and request_id = 'seed' and action = 'insert'
          and table_name in ('component', 'purchase_unit', 'concrete_type')
        group by table_name order by table_name`,
        [SYSTEM_ACTOR_ID],
      ),
    );
    expect(rows.map((r) => [r.table_name, Number(r.n)])).toEqual([
      ['component', 6],
      ['concrete_type', 4],
      ['purchase_unit', 7],
    ]);
  });

  it('refuses outside simulation, on real data and in production', async () => {
    await expect(seedPilotMasterData(system, { ...allowed, SIMULATION_ENABLED: false })).rejects.toThrow(
      /SIMULATION_ENABLED/,
    );
    await expect(seedPilotMasterData(system, { ...allowed, REAL_DATA: true })).rejects.toThrow(/REAL_DATA/);
    await expect(seedPilotMasterData(system, { ...allowed, NODE_ENV: 'production' })).rejects.toThrow(
      /production/,
    );
  });

  it('gives request roles no way in: only the system pool can insert seed rows', async () => {
    await expect(
      withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'owner', requestId: 'x' }, (tx) =>
        tx.query(`insert into concrete_type (id, code, label) values (gen_random_uuid(), 'ZQ1', 'x')`),
      ),
    ).rejects.toBeDefined();
  });
});
