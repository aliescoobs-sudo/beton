import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureRoles } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { seedPilotMasterData } from '../src/modules/master-data';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const seed = new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 1 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => Promise.all([seed.end(), system.end(), app.end()]));

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
            + (select count(*) from concrete_type) + (select count(*) from zone) + (select count(*) from client)
            + (select count(*) from supplier) + (select count(*) from truck) + (select count(*) from recette)
            + (select count(*) from recette_line) + (select count(*) from purchase_price)
            + (select count(*) from selling_price) as n`,
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
    await seedPilotMasterData(seed, allowed);
    expect(await counts()).toBe(before);
    expect(await sequence()).toEqual(seq);
    expect(seq).toEqual([{ last_value: expect.anything() }]);
  });

  it('audits every seeded row as the system actor with request id "seed"', async () => {
    const { rows } = await asOwner((tx) =>
      tx.query<{ table_name: string; n: string }>(
        `select table_name, count(*) as n from audit_event
        where actor_user_id = $1 and actor_kind = 'system' and request_id = 'seed' and action = 'insert'
          and table_name in ('component', 'purchase_unit', 'concrete_type', 'zone', 'client', 'supplier', 'truck',
                             'recette', 'recette_line', 'purchase_price', 'selling_price')
        group by table_name order by table_name`,
        [SYSTEM_ACTOR_ID],
      ),
    );
    expect(rows.map((r) => [r.table_name, Number(r.n)])).toEqual([
      ['client', 5],
      ['component', 15], // 6 + the 9 FX- components of the A1 cost seed (T16 G5)
      ['concrete_type', 12], // 7 classes (B10..B35) + the 5 FX- industrial recipes
      ['purchase_price', 15],
      ['purchase_unit', 16],
      ['recette', 8],
      ['recette_line', 57], // 18 + 7 + 7 + 8 + 8 + 9 doses of the five FX- recipes
      ['selling_price', 4],
      ['supplier', 5],
      ['truck', 4],
      ['zone', 5],
    ]);
  });

  it('seeds the 5 zones of D53 with their fixed ids and trip times', async () => {
    const { rows } = await asOwner((tx) =>
      tx.query(
        `select id, name, one_way_min from zone where id::text like '019c0000-0000-7000-8000-00000000000_' order by id`,
      ),
    );
    expect(rows).toEqual([
      { id: '019c0000-0000-7000-8000-000000000001', name: 'Tétouan centre', one_way_min: 20 },
      { id: '019c0000-0000-7000-8000-000000000002', name: 'Martil', one_way_min: 25 },
      { id: '019c0000-0000-7000-8000-000000000003', name: "M'diq", one_way_min: 30 },
      { id: '019c0000-0000-7000-8000-000000000004', name: 'Fnideq', one_way_min: 45 },
      { id: '019c0000-0000-7000-8000-000000000005', name: 'Oued Laou', one_way_min: 60 },
    ]);
  });

  it('seeds usable prices: B20/B25/B30 have one recette of 6 lines, a list price, and Atlas has a B25 override', async () => {
    const { rows } = await asOwner((tx) =>
      tx.query(
        `select t.code,
                (select count(*) from recette_line l join recette r on r.id = l.recette_id where r.concrete_type_id = t.id) as lines,
                (select price_ht_per_m3_centimes::int from selling_price p where p.concrete_type_id = t.id and p.client_id is null) as list,
                (select price_ht_per_m3_centimes::int from selling_price p join client c on c.id = p.client_id
                  where p.concrete_type_id = t.id and c.name like 'Entreprise Atlas BTP%') as atlas
           from concrete_type t where t.code in ('B20', 'B25', 'B30') order by t.code`,
      ),
    );
    expect(rows).toEqual([
      { code: 'B20', lines: '6', list: 78000, atlas: null },
      { code: 'B25', lines: '6', list: 85000, atlas: 82000 },
      { code: 'B30', lines: '6', list: 92000, atlas: null },
    ]);
  });

  it('refuses outside simulation, on real data and in production', async () => {
    await expect(seedPilotMasterData(seed, { ...allowed, SIMULATION_ENABLED: false })).rejects.toThrow(
      /SIMULATION_ENABLED/,
    );
    await expect(seedPilotMasterData(seed, { ...allowed, REAL_DATA: true })).rejects.toThrow(/REAL_DATA/);
    await expect(seedPilotMasterData(seed, { ...allowed, NODE_ENV: 'production' })).rejects.toThrow(
      /production/,
    );
  });

  it('runs as belgobeton_seed: the system role cannot insert master data, bump a counter or read prices', async () => {
    const asSystem = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
      withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'x' }, fn);
    for (const sql of [
      `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'ZQ1', 'x')`,
      `insert into zone (id, name, one_way_min) values (gen_random_uuid(), 'Zone ZQ', 5)`,
      `insert into truck (id, code, plate) values (gen_random_uuid(), 'T990', 'ZQ 1')`,
      `select public.next_code('ZQ', 2)`,
      `select count(*) from code_sequence`,
      `select count(*) from purchase_price`,
      `select count(*) from selling_price`,
    ]) {
      await expect(
        asSystem((tx) => tx.query(sql)),
        sql,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('gives request roles and the seed role itself no way to do more than insert master data', async () => {
    const asSeed = <T>(role: 'owner' | 'system', fn: (tx: pg.PoolClient) => Promise<T>) =>
      withRlsContext(seed, { userId: SYSTEM_ACTOR_ID, role, requestId: 'x' }, fn);
    // Row-level security still applies: the seed acts as the system actor, nothing else.
    await expect(
      asSeed('owner', (tx) =>
        tx.query(`insert into concrete_type (id, code, label) values (gen_random_uuid(), 'ZQ1', 'x')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    for (const sql of [
      `update concrete_type set label = 'x'`,
      'delete from zone',
      'truncate truck',
      `update recette set effective_from = '2000-01-01'`,
      `insert into parameter (key, value, updated_by, updated_at) values ('x.y', '1', gen_random_uuid(), now())`,
      'select count(*) from "user"',
      'select count(*) from audit_event',
    ]) {
      await expect(
        asSeed('system', (tx) => tx.query(sql)),
        sql,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('db:bootstrap disables the seed role when the flags forbid it, and re-enables it in simulation', async () => {
    const canLogin = async () =>
      (await asOwner((tx) => tx.query(`select rolcanlogin from pg_roles where rolname = 'belgobeton_seed'`)))
        .rows[0]?.rolcanlogin;
    expect(await canLogin()).toBe(true);
    try {
      await ensureRoles(env); // no seed URL: real data or production
      expect(await canLogin()).toBe(false);
      const blocked = new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 1 });
      await expect(blocked.query('select 1')).rejects.toThrow();
      await blocked.end().catch(() => undefined);
    } finally {
      await ensureRoles(env, env.DATABASE_URL_SEED);
    }
    expect(await canLogin()).toBe(true);
  });
});
