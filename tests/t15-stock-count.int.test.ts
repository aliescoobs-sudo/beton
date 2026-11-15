import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';
import { purchaseMaster } from './helpers/ledger-fixtures';

/**
 * T15 G1 (SPEC-stock-engine-gaps §3-§5): the count tolerance, the plant manager's proposed count, the owner's decision, and the invariant that only the plant's
 * BL (and a count) writes stock. Fictitious data. Refusals assert the SQLSTATE, not only the absence of a success.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `t15${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
let n = 0;

type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
interface Proposed {
  o_id: string;
  o_status: string;
  o_theoretical: string;
  o_variance: string;
  o_variance_bp: string | null;
  o_tolerance_bp: number;
  o_movement_id: string | null;
}
const propose = (u: U, comp: string, counted: number, category = 'error', reason = 'fictitious count') =>
  w.as(
    u,
    async (tx) =>
      (
        await tx.query<Proposed>('select * from public.propose_stock_count($1, $2, $3, $4)', [
          comp,
          counted,
          category,
          reason,
        ])
      ).rows[0]!,
  );
const decide = (u: U, count: string, accept: boolean, reason = 'fictitious decision') =>
  w.as(
    u,
    async (tx) =>
      (
        await tx.query<{ r: string | null }>('select public.decide_stock_count($1, $2, $3) as r', [
          count,
          accept,
          reason,
        ])
      ).rows[0]!.r,
  );
const setTol = (u: U, plant: string | null, comp: string | null, bp: number, from: string, floor = 0) =>
  w.as(
    u,
    async (tx) =>
      (
        await tx.query<{ r: string }>(
          'select public.set_stock_count_tolerance($1, $2, $3, $4, $5, $6) as r',
          [plant, comp, bp, floor, from, 'fictitious tolerance'],
        )
      ).rows[0]!.r,
  );

/** A component of its own with `qty` base units in plant `plant` (a seeded adjustment, so the level can also be negative). */
async function component(plant: string, qty: number | null): Promise<string> {
  const pm = await purchaseMaster(app, w.owner.id, `${marker}c${n++}`);
  if (qty !== null) {
    await w.sup(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
       values (gen_random_uuid(), $1, current_date, $2, 'count_adjustment', gen_random_uuid(), 'fictitious seed', $3, $4)`,
      [pm.componentId, qty, plant, w.owner.id],
    );
  }
  return pm.componentId;
}
const level = async (plant: string, comp: string) =>
  Number(
    (
      await w.sup<{ s: string }>(
        `select coalesce(sum(qty_base), 0)::text s from stock_movement where plant_id = $1 and component_id = $2`,
        [plant, comp],
      )
    )[0]!.s,
  );

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('T15 G1: the tolerance is data', () => {
  it('the seed is one global default of 200 bp, flagged as an assumption', async () => {
    const rows = await w.sup<{
      tolerance_bp: number;
      floor_qty: string;
      is_assumption: boolean;
      plant_id: string | null;
    }>(
      `select tolerance_bp, floor_qty::text, is_assumption, plant_id from stock_count_tolerance where plant_id is null and component_id is null and effective_from = '2000-01-01'`,
    );
    expect(rows).toEqual([{ tolerance_bp: 200, floor_qty: '0', is_assumption: true, plant_id: null }]);
  });

  it('the pilot seed also enters 0 bp for the admixture, as a flagged assumption', async () => {
    const rows = await w.sup<{ tolerance_bp: number; is_assumption: boolean }>(
      `select t.tolerance_bp, t.is_assumption from stock_count_tolerance t join component c on c.id = t.component_id where lower(c.name_fr) = 'adjuvant' and t.plant_id is null`,
    );
    expect(rows).toEqual([{ tolerance_bp: 0, is_assumption: true }]);
  });

  it('the most specific row wins: plant+component > component > plant > global, and a later date wins over an earlier one', async () => {
    // plant B carries the plant-level rows so that plant A keeps the 200 bp default for the other tests of this file
    const x = await component(w.plantB, 1_000_000);
    const y = await component(w.plantB, 1_000_000);
    expect((await propose(w.pmB, x, 1_000_000)).o_tolerance_bp).toBe(200); // global
    await setTol(w.owner, w.plantB, null, 300, '2001-01-03');
    expect((await propose(w.pmB, x, 1_000_000)).o_tolerance_bp).toBe(300); // plant only
    await setTol(w.appAdmin, null, y, 400, '2001-01-03');
    expect((await propose(w.pmB, y, 1_000_000)).o_tolerance_bp).toBe(400); // component beats plant
    expect((await propose(w.pmB, x, 1_000_000)).o_tolerance_bp).toBe(300);
    await setTol(w.owner, w.plantB, y, 500, '2001-01-03');
    expect((await propose(w.pmB, y, 1_000_000)).o_tolerance_bp).toBe(500); // plant+component beats both
    await setTol(w.owner, w.plantB, y, 600, '2001-01-04'); // a later date, same specificity
    expect((await propose(w.pmB, y, 1_000_000)).o_tolerance_bp).toBe(600);
    await setTol(w.owner, w.plantB, y, 700, '2999-01-01'); // not in force yet
    expect((await propose(w.pmB, y, 1_000_000)).o_tolerance_bp).toBe(600);
    // plant A has no plant row: its manager gets the component row (400 for y), then the global default
    await w.sup(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
       values (gen_random_uuid(), $1, current_date, 1000, 'count_adjustment', gen_random_uuid(), 'fictitious seed', $2, $3)`,
      [y, w.plantA, w.owner.id],
    );
    expect((await propose(w.pmA, y, 1000)).o_tolerance_bp).toBe(400);
    const z = await component(w.plantA, 1000);
    expect((await propose(w.pmA, z, 1000)).o_tolerance_bp).toBe(200);
  });

  it('only the owner and app_admin set a tolerance; every other role is refused with 42501, and a bad value with 23514', async () => {
    const c = await component(w.plantA, null);
    for (const u of [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA]) {
      expect(await code(() => setTol(u, null, c, 100, '2001-02-01')), u.role).toBe('42501');
    }
    expect(await code(() => setTol(w.owner, null, c, 10001, '2001-02-01'))).toBe('23514');
    expect(await code(() => setTol(w.owner, randomUUID(), null, 100, '2001-02-01'))).toBe('23514');
    expect(await code(() => setTol(w.owner, null, randomUUID(), 100, '2001-02-01'))).toBe('23514');
  });

  it('a tolerance is never edited or deleted, whoever asks', async () => {
    const id = await setTol(w.owner, null, await component(w.plantA, null), 100, '2001-02-02');
    expect(
      await code(() =>
        migrator.query(`update stock_count_tolerance set tolerance_bp = 1 where id = $1`, [id]),
      ),
    ).toBe('23000');
    expect(await code(() => migrator.query(`delete from stock_count_tolerance where id = $1`, [id]))).toBe(
      '23000',
    );
    expect(
      await code(() =>
        w.as(w.owner, (tx) =>
          tx.query(`update stock_count_tolerance set tolerance_bp = 1 where id = $1`, [id]),
        ),
      ),
    ).toBe('42501');
  });
});

describe('T15 G1: the plant manager proposes a count', () => {
  it('in tolerance the count posts its adjustment at once, with the tolerance snapshot and an audit row', async () => {
    const c = await component(w.plantA, 1_000_000);
    const r = await propose(w.pmA, c, 1_015_000, 'moisture', 'sand is wet');
    expect(r.o_status).toBe('in_tolerance_posted');
    expect([r.o_theoretical, r.o_variance, r.o_variance_bp, r.o_tolerance_bp]).toEqual([
      '1000000',
      '15000',
      '150',
      200,
    ]);
    expect(r.o_movement_id).not.toBeNull();
    expect(await level(w.plantA, c)).toBe(1_015_000);
    const [row] = await w.sup<{
      plant_id: string;
      status: string;
      tolerance_bp: number;
      is_assumption: boolean;
      movement_id: string;
    }>(
      `select s.plant_id, s.status, s.tolerance_bp, t.is_assumption, s.movement_id from stock_count s join stock_count_tolerance t on t.id = s.tolerance_id where s.id = $1`,
      [r.o_id],
    );
    expect(row).toMatchObject({
      plant_id: w.plantA,
      status: 'in_tolerance_posted',
      tolerance_bp: 200,
      is_assumption: true,
    });
    const [mv] = await w.sup<{ source: string; plant_id: string; qty: string; created_by: string }>(
      `select source, plant_id, qty_base::text qty, created_by from stock_movement where id = $1`,
      [r.o_movement_id],
    );
    expect(mv).toEqual({
      source: 'count_adjustment',
      plant_id: w.plantA,
      qty: '15000',
      created_by: w.pmA.id,
    });
    // the audit chain recorded the count, by this actor
    const audit = await w.sup<{ actor_user_id: string; action: string }>(
      `select actor_user_id, action from audit_event where table_name = 'stock_count' and row_id = $1`,
      [r.o_id],
    );
    expect(audit).toEqual([{ actor_user_id: w.pmA.id, action: 'insert' }]);
  });

  it('a count equal to the theoretical level is recorded and posts nothing', async () => {
    const c = await component(w.plantA, 5000);
    const r = await propose(w.pmA, c, 5000);
    expect([r.o_status, r.o_variance, r.o_variance_bp, r.o_movement_id]).toEqual([
      'in_tolerance_posted',
      '0',
      '0',
      null,
    ]);
    expect(await level(w.plantA, c)).toBe(5000);
  });

  it('out of tolerance the count waits: nothing is posted, the owner roles and the plant manager are notified', async () => {
    const c = await component(w.plantA, 1_000_000);
    const r = await propose(w.pmA, c, 1_100_000, 'loss', 'silo reading');
    expect([r.o_status, r.o_variance, r.o_variance_bp, r.o_movement_id]).toEqual([
      'pending_decision',
      '100000',
      '1000',
      null,
    ]);
    expect(await level(w.plantA, c)).toBe(1_000_000);
    const comp = (await w.sup<{ code: string }>(`select code from component where id = $1`, [c]))[0]!.code;
    const who = await w.sup<{ recipient: string }>(
      `select recipient::text from notification where kind = 'stock_count_variance' and params->>'component' = $1`,
      [comp],
    );
    const ids = who.map((x) => x.recipient);
    expect(ids).toContain(w.owner.id);
    expect(ids).toContain(w.appAdmin.id);
    expect(ids).toContain(w.pmA.id);
    expect(ids).not.toContain(w.pmB.id);
    expect(ids).not.toContain(w.purchases.id);
    expect(ids).not.toContain(w.sales.id);
    expect(ids).not.toContain(w.accountant.id);
    // a second proposal for the same component and plant is refused while one waits
    expect(await code(() => propose(w.pmA, c, 1_000_500))).toBe('23514');
  });

  it('the ratio is rounded half away from zero, and an absolute floor keeps a small difference in tolerance', async () => {
    const up = await component(w.plantA, 20_000);
    await setTol(w.owner, w.plantA, up, 10000, '2001-03-01');
    expect((await propose(w.pmA, up, 20_001)).o_variance_bp).toBe('1'); // 0.5 bp -> 1
    const down = await component(w.plantA, 20_000);
    await setTol(w.owner, w.plantA, down, 10000, '2001-03-01');
    expect((await propose(w.pmA, down, 19_999)).o_variance_bp).toBe('-1'); // -0.5 bp -> -1
    const third = await component(w.plantA, 3);
    await setTol(w.owner, w.plantA, third, 10000, '2001-03-01');
    expect((await propose(w.pmA, third, 4)).o_variance_bp).toBe('3333');
    const floor = await component(w.plantA, 1000);
    await setTol(w.owner, w.plantA, floor, 0, '2001-03-01', 50);
    expect((await propose(w.pmA, floor, 1040)).o_status).toBe('in_tolerance_posted'); // 400 bp > 0 but |40| <= floor 50
    expect((await propose(w.pmA, floor, 1200)).o_status).toBe('pending_decision'); // 160 > floor
  });

  it('a theoretical level of zero or less is "n/a" and always waits', async () => {
    const zero = await component(w.plantA, null);
    const r0 = await propose(w.pmA, zero, 10);
    expect([r0.o_status, r0.o_variance_bp]).toEqual(['pending_decision', null]);
    const neg = await component(w.plantA, -500);
    const rn = await propose(w.pmA, neg, 100);
    expect([rn.o_status, rn.o_variance, rn.o_variance_bp]).toEqual(['pending_decision', '600', null]);
  });

  it('a later tolerance change never rewrites a waiting count (the snapshot)', async () => {
    const c = await component(w.plantA, 100_000);
    const r = await propose(w.pmA, c, 105_000); // 500 bp > 200: waits
    expect(r.o_status).toBe('pending_decision');
    await setTol(w.owner, w.plantA, c, 9000, '2001-04-01');
    const [row] = await w.sup<{ tolerance_bp: number; status: string; in_tolerance: boolean }>(
      `select tolerance_bp, status, in_tolerance from stock_count where id = $1`,
      [r.o_id],
    );
    expect(row).toEqual({ tolerance_bp: 200, status: 'pending_decision', in_tolerance: false });
  });

  it("the plant is the manager's own: the count lands in his plant, and the other manager does not read it", async () => {
    const c = await component(w.plantA, 1000);
    await w.sup(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
       values (gen_random_uuid(), $1, current_date, 9000, 'count_adjustment', gen_random_uuid(), 'fictitious seed', $2, $3)`,
      [c, w.plantB, w.owner.id],
    );
    const a = await propose(w.pmA, c, 1000);
    const b = await propose(w.pmB, c, 9000);
    const seen = async (u: U) =>
      (
        await w.as(u, (tx) =>
          tx.query<{ id: string }>(`select id from stock_count where component_id = $1`, [c]),
        )
      ).rows.map((r) => r.id);
    expect(await seen(w.pmA)).toEqual([a.o_id]);
    expect(await seen(w.pmB)).toEqual([b.o_id]);
    expect((await seen(w.owner)).sort()).toEqual([a.o_id, b.o_id].sort());
    expect(await seen(w.purchases)).toEqual([]); // office roles read no stock
    expect(await seen(w.sales)).toEqual([]);
    expect(await level(w.plantB, c)).toBe(9000);
  });

  it('every role other than a plant manager is refused with 42501; so is a count of an unknown component (23514)', async () => {
    const c = await component(w.plantA, 1000);
    for (const u of [
      w.owner,
      w.appAdmin,
      w.purchases,
      w.sales,
      w.accountant,
      w.partner,
      w.support,
      w.driverUserA,
    ]) {
      expect(await code(() => propose(u, c, 1000)), u.role).toBe('42501');
    }
    expect(await code(() => propose(w.pmA, randomUUID(), 10))).toBe('23514');
    expect(await code(() => propose(w.pmA, c, -1))).toBe('23514');
    expect(await code(() => propose(w.pmA, c, 1000, 'nonsense', 'a reason'))).toBe('23514');
    expect(await code(() => propose(w.pmA, c, 1000, 'other', 'x'))).toBe('23514');
  });

  it('no direct write reaches the count tables or the stock: the doors are the only way (42501)', async () => {
    const c = await component(w.plantA, 1000);
    for (const u of [w.pmA, w.owner, w.appAdmin]) {
      expect(
        await code(() =>
          w.as(u, (tx) =>
            tx.query(
              `insert into stock_count (id, plant_id, component_id, count_date, counted_qty, theoretical_qty, variance_qty, tolerance_id, tolerance_bp, floor_qty, in_tolerance, status, category, reason, created_by)
               select gen_random_uuid(), $1, $2, current_date, 1, 1, 0, id, 200, 0, true, 'in_tolerance_posted', 'other', 'direct write', $3 from stock_count_tolerance limit 1`,
              [w.plantA, c, u.id],
            ),
          ),
        ),
        u.role,
      ).toBe('42501');
    }
    expect(
      await code(() =>
        w.as(w.pmA, (tx) =>
          tx.query(
            `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
             values (gen_random_uuid(), $1, current_date, 5, 'count_adjustment', gen_random_uuid(), 'direct write', $2, $3)`,
            [c, w.plantA, w.pmA.id],
          ),
        ),
      ),
    ).toBe('42501');
  });
});

describe('T15 G1: the owner decides a count out of tolerance', () => {
  it('accepting posts the counted variance once, with a decision row and a notice to the plant manager', async () => {
    const c = await component(w.plantA, 1_000_000);
    const r = await propose(w.pmA, c, 1_100_000);
    // a load or receipt arriving meanwhile does not change what was counted: the variance posted is the one of the count
    expect(await code(() => decide(w.pmA, r.o_id, true))).toBe('42501');
    expect(await level(w.plantA, c)).toBe(1_000_000);
    const mov = await decide(w.owner, r.o_id, true, 'checked on site');
    expect(mov).not.toBeNull();
    expect(await level(w.plantA, c)).toBe(1_100_000);
    const [d] = await w.sup<{ accepted: boolean; decided_by: string; reason: string }>(
      `select accepted, decided_by, reason from stock_count_decision where count_id = $1`,
      [r.o_id],
    );
    expect(d).toEqual({ accepted: true, decided_by: w.owner.id, reason: 'checked on site' });
    expect(await code(() => decide(w.owner, r.o_id, true))).toBe('23514'); // once
    expect(await code(() => decide(w.appAdmin, r.o_id, false))).toBe('23514');
    const comp = (await w.sup<{ code: string }>(`select code from component where id = $1`, [c]))[0]!.code;
    const told = await w.sup<{ recipient: string }>(
      `select recipient::text from notification where kind = 'stock_count_decided' and params->>'component' = $1`,
      [comp],
    );
    expect(told.map((x) => x.recipient)).toContain(w.pmA.id);
    expect(told.map((x) => x.recipient)).not.toContain(w.pmB.id);
    expect(told.map((x) => x.recipient)).not.toContain(w.purchases.id);
    // after the decision the component can be counted again
    expect((await propose(w.pmA, c, 1_100_000)).o_status).toBe('in_tolerance_posted');
  });

  it('rejecting posts nothing and frees the component for a recount; app_admin may decide', async () => {
    const c = await component(w.plantA, 1_000_000);
    const r = await propose(w.pmA, c, 1_300_000);
    expect(await decide(w.appAdmin, r.o_id, false, 'recount please')).toBeNull();
    expect(await level(w.plantA, c)).toBe(1_000_000);
    expect((await propose(w.pmA, c, 1_001_000)).o_status).toBe('in_tolerance_posted');
  });

  it('every role other than owner and app_admin is refused with 42501; an unknown or in-tolerance count with 23514', async () => {
    const c = await component(w.plantA, 1_000_000);
    const waiting = await propose(w.pmA, c, 1_400_000);
    for (const u of [w.pmA, w.pmB, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA]) {
      expect(await code(() => decide(u, waiting.o_id, true)), u.role).toBe('42501');
    }
    expect(await level(w.plantA, c)).toBe(1_000_000);
    expect(await code(() => decide(w.owner, randomUUID(), true))).toBe('23514');
    const c2 = await component(w.plantA, 1000);
    const posted = await propose(w.pmA, c2, 1010);
    expect(await code(() => decide(w.owner, posted.o_id, true))).toBe('23514');
  });

  it('counts and decisions are insert-only', async () => {
    const c = await component(w.plantA, 1000);
    const r = await propose(w.pmA, c, 5000);
    await decide(w.owner, r.o_id, false, 'recount');
    expect(
      await code(() =>
        migrator.query(`update stock_count set reason = 'edited reason' where id = $1`, [r.o_id]),
      ),
    ).toBe('23000');
    expect(await code(() => migrator.query(`delete from stock_count where id = $1`, [r.o_id]))).toBe('23000');
    expect(
      await code(() =>
        migrator.query(`update stock_count_decision set accepted = true where count_id = $1`, [r.o_id]),
      ),
    ).toBe('23000');
    expect(
      await code(() => migrator.query(`delete from stock_count_decision where count_id = $1`, [r.o_id])),
    ).toBe('23000');
  });
});

describe('T15 G1: the invariant, only the plant BL (and a count) decrements stock', () => {
  it("a loaded stage leaves the sum of the plant's stock movements unchanged", async () => {
    const t = await w.newTrip(w.plantA, w.truckA, w.driverA);
    const sum = async () =>
      (
        await w.sup<{ s: string; n: string }>(
          `select coalesce(sum(qty_base), 0)::text s, count(*)::text n from stock_movement where plant_id = $1`,
          [w.plantA],
        )
      )[0]!;
    const before = await sum();
    await w.tap(w.driverUserA as never, t.trip, 'loaded');
    const [ev] = await w.sup<{ n: string }>(
      `select count(*)::text n from trip_event where trip_id = $1 and step = 'loaded'`,
      [t.trip],
    );
    expect(ev!.n).toBe('1'); // the stage was really written
    expect(await sum()).toEqual(before);
  });

  it('no login role but the application, the migrator and the simulation seed can insert into stock_movement (a future ingestion role must not)', async () => {
    const rows = await w.sup<{ rolname: string }>(
      `select r.rolname from pg_roles r where not r.rolsuper and r.rolname !~ '^pg_' and has_table_privilege(r.oid, 'public.stock_movement', 'INSERT') order by 1`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(['belgobeton_app', 'belgobeton_migrator', 'belgobeton_seed']);
  });

  it('a driver or a pump operator cannot insert a movement through the application login (42501)', async () => {
    const c = await component(w.plantA, 1000);
    for (const u of [w.driverUserA]) {
      expect(
        await code(() =>
          w.as(u, (tx) =>
            tx.query(
              `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
               values (gen_random_uuid(), $1, current_date, -5, 'count_adjustment', gen_random_uuid(), 'direct write', $2, $3)`,
              [c, w.plantA, u.id],
            ),
          ),
        ),
        u.role,
      ).toBe('42501');
    }
  });
});
