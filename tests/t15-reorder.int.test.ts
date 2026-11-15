import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { reorderThreshold } from '../src/modules/operations/domain/stock';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import { insertPurchase, purchaseMaster } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';

/** T15 G2 (SPEC-stock-engine-gaps §6): the reorder request, its doors, the link to a purchase and the daily job. Fictitious data; refusals assert the SQLSTATE. */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const marker = `t15r${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
let n = 0;
type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const day = '2026-11-15';
const create = (u: U, comp: string, qty = 5000, reason = 'fictitious need') =>
  w.as(
    u,
    async (tx) =>
      (
        await tx.query<{ r: string }>('select public.create_reorder_request($1,$2,$3,$4) as r', [
          comp,
          qty,
          day,
          reason,
        ])
      ).rows[0]!.r,
  );
const call = (u: U, sql: string, params: unknown[]) => w.as(u, (tx) => tx.query(sql, params));
const state = async (id: string) =>
  (await w.sup<{ s: string }>(`select public.reorder_state($1) s`, [id]))[0]!.s;
async function comp(): Promise<string> {
  return (await purchaseMaster(app, w.owner.id, `${marker}c${n++}`)).componentId;
}
const asSystem = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: marker }, fn);
const seeRows = async (u: U) =>
  (
    await w.as(u, (tx) =>
      tx.query<{ id: string }>(`select id from reorder_request where reason like $1`, [`% rd${marker}`]),
    )
  ).rows.map((r) => r.id);

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end(), system.end()]);
});

describe('T15 G2: the request', () => {
  it('a plant manager creates a request for his plant; office_purchases and the owner roles are told, nobody else', async () => {
    const c = await comp();
    const id = await create(w.pmA, c, 5000, `need ${marker}`);
    const [row] = await w.sup<{ plant_id: string; auto: boolean; created_by: string }>(
      `select plant_id, auto_from_threshold auto, created_by from reorder_request where id = $1`,
      [id],
    );
    expect(row).toEqual({ plant_id: w.plantA, auto: false, created_by: w.pmA.id });
    expect(await state(id)).toBe('open');
    const cc = (await w.sup<{ code: string }>(`select code from component where id = $1`, [c]))[0]!.code;
    const who = (
      await w.sup<{ recipient: string }>(
        `select recipient::text from notification where kind = 'reorder_request' and params->>'component' = $1`,
        [cc],
      )
    ).map((r) => r.recipient);
    for (const u of [w.purchases, w.owner, w.appAdmin]) expect(who).toContain(u.id);
    for (const u of [w.sales, w.accountant, w.pmB]) expect(who).not.toContain(u.id);
    const audit = await w.sup(
      `select 1 from audit_event where table_name = 'reorder_request' and row_id = $1 and actor_user_id = $2`,
      [id, w.pmA.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('one open request per plant and component (23505); another plant is free; after cancelling a new one is allowed', async () => {
    const c = await comp();
    const a = await create(w.pmA, c);
    expect(await code(() => create(w.pmA, c))).toBe('23505');
    expect(
      await code(() =>
        migrator.query(
          `insert into reorder_request (id, plant_id, component_id, requested_qty, needed_by, reason, created_by) values (gen_random_uuid(), $1, $2, 1, current_date, 'direct writer', $3)`,
          [w.plantA, c, w.owner.id],
        ),
      ),
    ).toBe('23505');
    await create(w.pmB, c);
    await call(w.pmA, 'select public.cancel_reorder_request($1, $2)', [a, 'no longer needed']);
    expect(await state(a)).toBe('cancelled');
    await create(w.pmA, c);
  });

  it('every other role is refused with 42501, bad input with 23514', async () => {
    const c = await comp();
    for (const u of [
      w.owner,
      w.appAdmin,
      w.purchases,
      w.sales,
      w.accountant,
      w.partner,
      w.support,
      w.driverUserA,
    ])
      expect(await code(() => create(u, c)), u.role).toBe('42501');
    expect(await code(() => create(w.pmA, c, 0))).toBe('23514');
    expect(await code(() => create(w.pmA, randomUUID()))).toBe('23514');
    expect(await code(() => create(w.pmA, c, 10, 'x'))).toBe('23514');
  });

  it('reads: a plant manager sees his plant, office_purchases and the owner roles all, other offices and drivers none', async () => {
    const c = await comp();
    const a = await create(w.pmA, c, 100, `a rd${marker}`);
    const b = await create(w.pmB, c, 100, `b rd${marker}`);
    expect(await seeRows(w.pmA)).toEqual([a]);
    expect(await seeRows(w.pmB)).toEqual([b]);
    for (const u of [w.purchases, w.owner, w.appAdmin])
      expect((await seeRows(u)).sort()).toEqual([a, b].sort());
    for (const u of [w.sales, w.accountant, w.driverUserA]) expect(await seeRows(u), u.role).toEqual([]);
  });

  it('no direct write reaches the tables (42501) and requests and events are insert-only (23000)', async () => {
    const c = await comp();
    const id = await create(w.pmA, c);
    for (const u of [w.pmA, w.owner, w.purchases])
      expect(
        await code(() =>
          call(
            u,
            `insert into reorder_request (id, plant_id, component_id, requested_qty, needed_by, reason, created_by) values (gen_random_uuid(), $1, $2, 1, current_date, 'direct writer', $3)`,
            [w.plantA, c, u.id],
          ),
        ),
        u.role,
      ).toBe('42501');
    expect(
      await code(() => migrator.query(`update reorder_request set requested_qty = 9 where id = $1`, [id])),
    ).toBe('23000');
    expect(await code(() => migrator.query(`delete from reorder_request where id = $1`, [id]))).toBe('23000');
    expect(
      await code(() => migrator.query(`delete from reorder_request_event where request_id = $1`, [id])),
    ).toBe('23000');
  });
});

describe('T15 G2: handling and conversion', () => {
  async function purchaseFor(plant: string | null, component: string) {
    const pm = await purchaseMaster(app, w.owner.id, `${marker}p${n++}`);
    return w.asOwnerIn(plant ?? w.plantA, async (tx) => {
      const id = (await insertPurchase(tx, w.owner.id, { ...pm, componentId: component, unitId: pm.unitId }))
        .id;
      if (plant === null) await tx.query(`select 1`);
      return id;
    });
  }
  it('seen, then linked to a purchase that orders the component for the plant; the whole tuple is checked', async () => {
    const pm = await purchaseMaster(app, w.owner.id, `${marker}lk${n++}`);
    const id = await create(w.pmA, pm.componentId);
    for (const u of [w.pmA, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(await code(() => call(u, 'select public.mark_reorder_seen($1)', [id])), u.role).toBe('42501');
    await call(w.purchases, 'select public.mark_reorder_seen($1)', [id]);
    expect(await state(id)).toBe('seen');
    expect(await code(() => call(w.purchases, 'select public.mark_reorder_seen($1)', [id]))).toBe('23514');
    // a purchase for another component, and an unknown one, are refused
    const other = await w.asOwnerIn(w.plantA, (tx) =>
      purchaseMaster(app, w.owner.id, `${marker}ot${n++}`).then((m) => insertPurchase(tx, w.owner.id, m)),
    );
    expect(
      await code(() => call(w.purchases, 'select public.link_reorder_to_purchase($1,$2)', [id, other.code])),
    ).toBe('23514');
    expect(
      await code(() =>
        call(w.purchases, 'select public.link_reorder_to_purchase($1,$2)', [id, 'ACH-0000-00000']),
      ),
    ).toBe('23514');
    // a purchase of the other plant is refused
    const pB = await w.asOwnerIn(w.plantB, (tx) => insertPurchase(tx, w.owner.id, pm));
    expect(
      await code(() => call(w.purchases, 'select public.link_reorder_to_purchase($1,$2)', [id, pB.code])),
    ).toBe('23514');
    for (const u of [w.pmA, w.sales, w.accountant, w.driverUserA])
      expect(
        await code(() => call(u, 'select public.link_reorder_to_purchase($1,$2)', [id, other.code])),
        u.role,
      ).toBe('42501');
    const pA = await w.asOwnerIn(w.plantA, (tx) => insertPurchase(tx, w.owner.id, pm));
    await call(w.purchases, 'select public.link_reorder_to_purchase($1,$2)', [id, pA.code]);
    expect(await state(id)).toBe('ordered');
    const [ev] = await w.sup<{ purchase_id: string }>(
      `select purchase_id from reorder_request_event where request_id = $1 and status = 'ordered'`,
      [id],
    );
    expect(ev!.purchase_id).toBe(pA.id);
    // terminal: no second link, no cancel
    expect(
      await code(() => call(w.purchases, 'select public.link_reorder_to_purchase($1,$2)', [id, pA.code])),
    ).toBe('23514');
    expect(
      await code(() => call(w.owner, 'select public.cancel_reorder_request($1,$2)', [id, 'too late'])),
    ).toBe('23514');
    void purchaseFor;
  });

  it('cancel: own plant manager, owner, app_admin with a reason; another plant manager and the others are refused', async () => {
    const c = await comp();
    const id = await create(w.pmA, c);
    for (const u of [w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA])
      expect(
        await code(() => call(u, 'select public.cancel_reorder_request($1,$2)', [id, 'a reason'])),
        u.role,
      ).toBe('42501');
    expect(
      await code(() => call(w.pmB, 'select public.cancel_reorder_request($1,$2)', [id, 'not mine'])),
    ).toBe('23514');
    expect(await code(() => call(w.pmA, 'select public.cancel_reorder_request($1,$2)', [id, 'x']))).toBe(
      '23514',
    ); // a too short reason is refused (CHECK)
    expect(await state(id)).toBe('open');
    await call(w.appAdmin, 'select public.cancel_reorder_request($1,$2)', [id, 'owner decided']);
    expect(await state(id)).toBe('cancelled');
  });
});

describe('T15 G2: the list door', () => {
  it('office_purchases sees every plant with the purchase code once ordered; a plant manager his plant; other roles are refused (42501)', async () => {
    const pm = await purchaseMaster(app, w.owner.id, `${marker}ls${n++}`);
    const a = await create(w.pmA, pm.componentId);
    const b = await create(w.pmB, pm.componentId);
    const pA = await w.asOwnerIn(w.plantA, (tx) => insertPurchase(tx, w.owner.id, pm));
    await call(w.purchases, 'select public.link_reorder_to_purchase($1,$2)', [a, pA.code]);
    const list = (u: U) =>
      w.as(
        u,
        async (tx) =>
          (
            await tx.query<{ o_id: string; o_state: string; o_purchase_code: string | null }>(
              'select * from public.reorder_requests_list()',
            )
          ).rows,
      );
    const all = await list(w.purchases);
    expect(all.find((r) => r.o_id === a)).toMatchObject({ o_state: 'ordered', o_purchase_code: pA.code });
    expect(all.find((r) => r.o_id === b)).toMatchObject({ o_state: 'open', o_purchase_code: null });
    expect((await list(w.pmA)).map((r) => r.o_id)).toContain(a);
    expect((await list(w.pmA)).map((r) => r.o_id)).not.toContain(b);
    for (const u of [w.sales, w.accountant, w.driverUserA, w.partner, w.support])
      expect(await code(() => list(u)), u.role).toBe('42501');
  });
});

describe('T15 G2: the daily job', () => {
  it('the system actor creates one request for a component below its threshold, once, and nobody else may call the door', async () => {
    const c = await comp();
    await w.sup(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by) values (gen_random_uuid(), $1, current_date, 100, 'count_adjustment', gen_random_uuid(), 'fictitious seed', $2, $3)`,
      [c, w.plantA, w.owner.id],
    );
    await w.sup(
      `insert into stock_threshold (id, component_id, plant_id, low_qty_base, created_by) values (gen_random_uuid(), $1, $2, 1000, $3)`,
      [c, w.plantA, w.owner.id],
    );
    for (const u of [w.owner, w.appAdmin, w.pmA, w.purchases])
      expect(await code(() => call(u, 'select public.create_auto_reorder_requests($1)', [day])), u.role).toBe(
        '42501',
      );
    const first = await asSystem(
      async (tx) =>
        (await tx.query<{ n: number }>('select public.create_auto_reorder_requests(current_date) n')).rows[0]!
          .n,
    );
    expect(first).toBeGreaterThanOrEqual(1);
    const rows = await w.sup<{
      requested_qty: string;
      auto_from_threshold: boolean;
      level_qty: string;
      threshold_qty: string;
      created_by: string;
    }>(
      `select requested_qty::text, auto_from_threshold, level_qty::text, threshold_qty::text, created_by from reorder_request where component_id = $1 and plant_id = $2`,
      [c, w.plantA],
    );
    expect(rows).toEqual([
      {
        requested_qty: '900',
        auto_from_threshold: true,
        level_qty: '100',
        threshold_qty: '1000',
        created_by: SYSTEM_ACTOR_ID,
      },
    ]);
    await asSystem((tx) => tx.query('select public.create_auto_reorder_requests(current_date)'));
    expect(await w.sup(`select 1 from reorder_request where component_id = $1`, [c])).toHaveLength(1);
    // above the threshold: nothing
    const d = await comp();
    await w.sup(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by) values (gen_random_uuid(), $1, current_date, 5000, 'count_adjustment', gen_random_uuid(), 'fictitious seed', $2, $3)`,
      [d, w.plantA, w.owner.id],
    );
    await w.sup(
      `insert into stock_threshold (id, component_id, plant_id, low_qty_base, created_by) values (gen_random_uuid(), $1, $2, 1000, $3)`,
      [d, w.plantA, w.owner.id],
    );
    await asSystem((tx) => tx.query('select public.create_auto_reorder_requests(current_date)'));
    expect(await w.sup(`select 1 from reorder_request where component_id = $1`, [d])).toHaveLength(0);
  });

  it('the SQL formula equals the TypeScript one', async () => {
    for (const [consumed, window, lead, safety] of [
      [0, 30, 2, 1],
      [-5, 30, 2, 1],
      [1, 30, 2, 1],
      [3000, 30, 2, 1],
      [10001, 30, 5, 0],
      [7, 7, 0, 0],
      [500, 0, 2, 1],
      [999, 30, -1, 1],
    ] as const) {
      const sql = (
        await w.sup<{ t: string | null }>(`select public.reorder_threshold_qty($1,$2,$3,$4)::text t`, [
          consumed,
          window,
          lead,
          safety,
        ])
      )[0]!.t;
      const ts = reorderThreshold({
        consumedBase: consumed,
        windowDays: window,
        leadDays: lead,
        safetyDays: safety,
      });
      expect(sql === null ? null : Number(sql)).toBe(ts);
    }
  });
});
