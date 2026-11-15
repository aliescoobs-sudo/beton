import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelLoad } from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { noActorOffenders } from './helpers/no-actor-sweep';
import { testEnv } from './db-env';
import { insertDelivery, insertOrder, orderMaster } from './helpers/ledger-fixtures';
import { plantWorld, type World } from './helpers/plant-world';

/** T16 G4 (SPEC-cost-margin §3, §4; D236): the discharge method, the recette mapping and the price grid. Fictitious data only; refusals assert the SQLSTATE. */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `t16a${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
type U = { id: string; role: string };
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const call = (u: U, sql: string, params: unknown[] = []) => w.as(u, (tx) => tx.query(sql, params));
const others = () => [w.pmA, w.purchases, w.sales, w.accountant, w.partner, w.support, w.driverUserA];
let typeId: string;
let n = 0;
/** A class of its own per test, so the shared database never collides on a version date. */
async function freshClass(): Promise<string> {
  return (
    await w.sup<{ id: string }>(
      `insert into concrete_type (id, code, label) values (gen_random_uuid(), 'G' || upper(substr(md5(random()::text), 1, 8)), $1) returning id`,
      [`t16 ${marker} ${n++}`],
    )
  )[0]!.id;
}

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
  typeId = (await orderMaster(app, w.owner.id, `${marker}a`)).typeId;
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

describe('T16 G4: the discharge method on the order line and the BL', () => {
  it('a legacy order and its BL keep NULL: the method is never invented', async () => {
    const m = { ...(await orderMaster(app, w.owner.id, `${marker}a`)), clientId: w.scene.clientId };
    const o = await w.asOwnerIn(w.plantA, (tx) => insertOrder(tx, w.owner.id, m));
    const d = await w.asOwnerIn(w.plantA, (tx) =>
      insertDelivery(tx, w.owner.id, {
        orderId: o.id,
        truckId: w.scene.truckId,
        recetteId: w.scene.recetteId,
      }),
    );
    expect(
      (await w.sup(`select discharge_method m from sales_order where id = $1`, [o.id]))[0]!.m,
    ).toBeNull();
    expect(
      (await w.sup(`select discharge_method m from delivery where bl_no = $1`, [d.blNo]))[0]!.m,
    ).toBeNull();
  });

  it('the BL takes the method of its order, an explicit disagreeing method is refused, a reversing BL takes its original', async () => {
    const m = { ...(await orderMaster(app, w.owner.id, `${marker}a`)), clientId: w.scene.clientId };
    const o = await w.asOwnerIn(w.plantA, (tx) =>
      insertOrder(tx, w.owner.id, m, '2026-06-02', null, 'POMPE'),
    );
    const d = await w.asOwnerIn(w.plantA, (tx) =>
      insertDelivery(tx, w.owner.id, {
        orderId: o.id,
        truckId: w.scene.truckId,
        recetteId: w.scene.recetteId,
      }),
    );
    const row = (
      await w.sup<{ id: string; m: string }>(`select id, discharge_method m from delivery where bl_no = $1`, [
        d.blNo,
      ])
    )[0]!;
    expect(row.m).toBe('POMPE');
    expect(
      await code(() =>
        w.asOwnerIn(w.plantA, (tx) =>
          tx.query(
            `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, recette_id, created_by, discharge_method)
             values (gen_random_uuid(), public.next_doc_number('BL', 2026, 5), $1, $2, 1000, '2026-06-01', $3, $4, 'GOULOTTE')`,
            [o.id, w.scene.truckId, w.scene.recetteId, w.owner.id],
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await code(() =>
        w.asOwnerIn(w.plantA, (tx) =>
          tx.query(
            `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, recette_id, created_by, discharge_method)
             values (gen_random_uuid(), public.next_doc_number('BL', 2026, 5), $1, $2, 1000, '2026-06-01', $3, $4, 'BETON')`,
            [o.id, w.scene.truckId, w.scene.recetteId, w.owner.id],
          ),
        ),
      ),
    ).toBe('23514');
    const cancelled = await cancelLoad(
      app,
      w.owner as unknown as SessionUser,
      { deliveryId: row.id, reason: 'fictitious cancel' },
      { today: '2026-06-01' },
    );
    expect(cancelled.ok).toBe(true);
    const rev = cancelled.ok ? cancelled.value.id : '';
    expect((await w.sup(`select discharge_method m from delivery where id = $1`, [rev]))[0]!.m).toBe('POMPE');
  });

  it('create_order with a method records it; a missing or unknown method is refused (23514); the order keeps all its other rules', async () => {
    const m = { ...(await orderMaster(app, w.owner.id, `${marker}a`)), clientId: w.scene.clientId };
    const inPlant = (u: U, sql: string, params: unknown[]) =>
      w.as(u, async (tx) => {
        await tx.query(`select set_config('app.plant_id', $1, true)`, [w.plantA]);
        return tx.query(sql, params);
      });
    const make = (u: U, method: string | null) =>
      inPlant(
        u,
        `select * from public.create_order_with_method($1, null, null, $2, 10000, current_date + 5, current_date, null, null, $3::jsonb, 2000, $4)`,
        [m.clientId, m.typeId, JSON.stringify({ preset: 'cash' }), method],
      );
    const r = await make(w.owner, 'POMPE');
    const id = r.rows[0]!.id as string;
    expect((await w.sup(`select discharge_method m from sales_order where id = $1`, [id]))[0]!.m).toBe(
      'POMPE',
    );
    const g = await make(w.appAdmin, 'GOULOTTE');
    expect(
      (await w.sup(`select discharge_method m from sales_order where id = $1`, [g.rows[0]!.id]))[0]!.m,
    ).toBe('GOULOTTE');
    expect(await code(() => make(w.owner, null))).toBe('23514');
    expect(await code(() => make(w.owner, 'BETON'))).toBe('23514');
    // the setting does not leak: the plain create_order door afterwards records NO method
    const legacy = await inPlant(
      w.owner,
      `select * from public.create_order($1, null, null, $2, 10000, current_date + 5, current_date, null, null, $3::jsonb, 2000)`,
      [m.clientId, m.typeId, JSON.stringify({ preset: 'cash' })],
    );
    expect(
      (await w.sup(`select discharge_method m from sales_order where id = $1`, [legacy.rows[0]!.id]))[0]!.m,
    ).toBeNull();
    // purchases keeps being refused by the wrapped door
    expect(await code(() => make(w.purchases, 'POMPE'))).toBe('42501');
  });

  it('create_order_with_method refuses every context that is not an admitted actor, with a real client and class, and writes nothing', async () => {
    const m = { ...(await orderMaster(app, w.owner.id, `${marker}a`)), clientId: w.scene.clientId };
    const before = (await w.sup<{ c: string }>(`select count(*)::text c from sales_order`))[0]!.c;
    const offenders = await noActorOffenders(
      app,
      `select * from public.create_order_with_method($1, null, null, $2, 10000, current_date + 5, current_date, null, null, '{"preset":"cash"}'::jsonb, 2000, 'POMPE')`,
      [m.clientId, m.typeId],
      { plantManager: w.pmA.id, driver: w.driverUserA.id },
    );
    expect(offenders).toEqual([]);
    expect((await w.sup<{ c: string }>(`select count(*)::text c from sales_order`))[0]!.c).toBe(before);
  });
});

describe('T16 G4: the price grid', () => {
  const set = (u: U, cls: string, method: string, price: number, from: string, reason = 'fictitious grid') =>
    call(u, 'select public.set_price_grid($1,$2,$3,$4,$5) as r', [cls, method, price, from, reason]);

  it('owner and app_admin write a version (a replacement is a new row, not flagged as an assumption); the pump is part of the POMPE price', async () => {
    const c = await freshClass();
    const a = (await set(w.owner, c, 'GOULOTTE', 74_000, '2026-01-01')).rows[0]!.r as string;
    const b = (await set(w.appAdmin, c, 'POMPE', 79_000, '2026-01-01')).rows[0]!.r as string;
    const rows = await w.sup<{ id: string; p: string; a: boolean }>(
      `select id, price_ht_per_m3_centimes::text p, is_assumption a from price_grid where concrete_type_id = $1 order by discharge_method`,
      [c],
    );
    expect(rows.map((r) => [r.id, r.p, r.a])).toEqual([
      [a, '74000', false],
      [b, '79000', false],
    ]);
    expect(
      (
        await w.sup(
          `select 1 from audit_event where table_name = 'price_grid' and row_id = $1 and actor_user_id = $2`,
          [a, w.owner.id],
        )
      ).length,
    ).toBe(1);
  });

  it('versions go forward in time; bad input is refused (23514); an unknown class is refused', async () => {
    const c = await freshClass();
    await set(w.owner, c, 'GOULOTTE', 74_000, '2026-03-01');
    expect(await code(() => set(w.owner, c, 'GOULOTTE', 75_000, '2026-03-01'))).toBe('23514');
    expect(await code(() => set(w.owner, c, 'GOULOTTE', 75_000, '2026-02-01'))).toBe('23514');
    await set(w.owner, c, 'GOULOTTE', 75_000, '2026-04-01');
    expect(await code(() => set(w.owner, c, 'GOULOTTE', 0, '2026-05-01'))).toBe('23514');
    expect(await code(() => set(w.owner, c, 'GOULOTTE', -5, '2026-05-01'))).toBe('23514');
    expect(await code(() => set(w.owner, c, 'BETON', 75_000, '2026-05-01'))).toBe('23514');
    expect(await code(() => set(w.owner, c, 'POMPE', 75_000, '2026-05-01', ' '))).toBe('23514');
    expect(await code(() => set(w.owner, randomUUID(), 'POMPE', 75_000, '2026-05-01'))).toBe('23514');
  });

  it('every other role is refused (42501) on the write door and on the mapping door; office_sales may read the grid but not the mapping', async () => {
    const c = await freshClass();
    for (const u of others()) {
      expect(await code(() => set(u, c, 'POMPE', 79_000, '2026-01-01')), u.role).toBe('42501');
      expect(
        await code(() =>
          call(u, 'select public.set_class_method_recette($1,$2,null,$3,$4,$5)', [
            c,
            'POMPE',
            w.scene.recetteId,
            '2026-01-01',
            'fictitious',
          ]),
        ),
        u.role,
      ).toBe('42501');
      expect(await code(() => call(u, 'select * from public.class_method_recette_list()')), u.role).toBe(
        '42501',
      );
      if (u !== w.sales)
        expect(await code(() => call(u, 'select * from public.price_grid_list()')), u.role).toBe('42501');
    }
    expect(await code(() => call(w.sales, 'select * from public.price_grid_list()'))).toBeUndefined();
    expect(await code(() => call(w.sales, 'select * from public.class_method_recette_list()'))).toBe('42501');
    expect(
      await code(() => call(w.owner, 'select * from public.class_method_recette_list()')),
    ).toBeUndefined();
    expect(await code(() => call(w.appAdmin, 'select * from public.price_grid_list()'))).toBeUndefined();
    const total = (
      await w.sup<{ c: string }>(`select count(*)::text c from price_grid where concrete_type_id = $1`, [c])
    )[0]!.c;
    expect(total).toBe('0');
  });

  it('no role reads or writes either table directly (42501), the owner included; nothing is updated or deleted; the audit rows are the owner roles only', async () => {
    const c = await freshClass();
    const id = (await set(w.owner, c, 'POMPE', 79_000, '2026-01-01')).rows[0]!.r as string;
    for (const u of [w.owner, w.appAdmin, ...others()]) {
      for (const t of ['price_grid', 'class_method_recette']) {
        expect(await code(() => call(u, `select * from ${t}`)), `${u.role} select ${t}`).toBe('42501');
        expect(await code(() => call(u, `delete from ${t}`)), `${u.role} delete ${t}`).toBe('42501');
        expect(await code(() => call(u, `update ${t} set reason = 'x'`)), `${u.role} update ${t}`).toBe(
          '42501',
        );
      }
      expect(
        await code(() =>
          call(
            u,
            `insert into price_grid (concrete_type_id, discharge_method, price_ht_per_m3_centimes, effective_from, reason, created_by) values ($1, 'POMPE', 1, '2030-01-01', 'direct', $2)`,
            [c, u.id],
          ),
        ),
        `${u.role} insert`,
      ).toBe('42501');
    }
    expect(await code(() => migrator.query(`update price_grid set reason = 'x' where id = $1`, [id]))).toBe(
      '23000',
    );
    expect(await code(() => migrator.query(`delete from price_grid where id = $1`, [id]))).toBe('23000');
    const audit = (u: U) =>
      w.as(
        u,
        async (tx) =>
          (
            await tx.query(
              `select 1 from audit_event where table_name in ('price_grid', 'class_method_recette')`,
            )
          ).rows.length,
      );
    expect(await audit(w.owner)).toBeGreaterThan(0);
    expect(await audit(w.appAdmin)).toBeGreaterThan(0);
    for (const u of [w.partner, w.support, w.sales, w.purchases, w.pmA, w.accountant])
      expect(await audit(u), u.role).toBe(0);
  });

  it('the write doors refuse every context that is not an admitted actor, with real targets, and write nothing', async () => {
    const c = await freshClass();
    const real = { plantManager: w.pmA.id, driver: w.driverUserA.id };
    expect(
      await noActorOffenders(
        app,
        'select public.set_price_grid($1,$2,$3,$4,$5)',
        [c, 'POMPE', 79_000, '2026-01-01', 'sweep'],
        real,
      ),
    ).toEqual([]);
    expect(
      await noActorOffenders(
        app,
        'select public.set_class_method_recette($1,$2,null,$3,$4,$5)',
        [c, 'POMPE', w.scene.recetteId, '2026-01-01', 'sweep'],
        real,
      ),
    ).toEqual([]);
    expect(await noActorOffenders(app, 'select * from public.price_grid_list()', [], real)).toEqual([]);
    expect(await noActorOffenders(app, 'select * from public.class_method_recette_list()', [], real)).toEqual(
      [],
    );
    expect(
      (
        await w.sup<{ c: string }>(`select count(*)::text c from price_grid where concrete_type_id = $1`, [c])
      )[0]!.c,
    ).toBe('0');
  });

  it('the internal lookups are not executable by any request role; the price in force is the latest started version', async () => {
    const c = await freshClass();
    await set(w.owner, c, 'GOULOTTE', 74_000, '2026-01-01');
    await set(w.owner, c, 'GOULOTTE', 76_000, '2026-06-01');
    for (const u of [w.owner, w.appAdmin, w.sales])
      expect(
        await code(() =>
          call(u, `select * from public._price_grid_in_force($1,'GOULOTTE','2026-07-01')`, [c]),
        ),
        u.role,
      ).toBe('42501');
    const at = async (d: string) =>
      (
        await w.sup<{ p: string | null }>(
          `select (select price_centimes::text from public._price_grid_in_force($1, 'GOULOTTE', $2::date)) p`,
          [c, d],
        )
      )[0]!.p;
    expect(await at('2025-12-31')).toBeNull();
    expect(await at('2026-05-31')).toBe('74000');
    expect(await at('2026-06-01')).toBe('76000');
  });

  it('an invoice line is the invoiced m3 times the order price per m3, one line per BL: no separate pump line can exist', async () => {
    const cols = await w.sup<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns where table_name = 'invoice_line' and table_schema = 'public'`,
    );
    expect(cols.find((c) => c.column_name === 'delivery_id')?.is_nullable).toBe('NO');
    expect(cols.map((c) => c.column_name)).not.toContain('kind');
    // 10 m3 (10 000 l) at 790,00 DH (the grid POMPE price of the seed): one rounding, to the centime
    const line = (await w.sup<{ v: string }>(`select public.scale_qty(10000, 79000, 1000)::text v`))[0]!.v;
    expect(line).toBe('790000');
    expect((await w.sup<{ v: string }>(`select public.scale_qty(3333, 79000, 1000)::text v`))[0]!.v).toBe(
      '263307',
    );
  });
});

describe('T16 G4: the recette mapping', () => {
  const map = (u: U, cls: string, method: string, plant: string | null, recette: string, from: string) =>
    call(u, 'select public.set_class_method_recette($1,$2,$3,$4,$5,$6) as r', [
      cls,
      method,
      plant,
      recette,
      from,
      'fictitious mapping',
    ]);

  it('owner roles map (class, method, plant) to a recette, versioned and insert-only; the plant mapping wins over the all-plants one', async () => {
    const c = typeId;
    const day = `20${40 + (n++ % 50)}-01-01`;
    const later = day.replace('-01-01', '-06-01');
    await map(w.owner, c, 'POMPE', null, w.scene.recetteId, day);
    await map(w.appAdmin, c, 'POMPE', w.plantA, w.scene.recetteId, day);
    expect(await code(() => map(w.owner, c, 'POMPE', null, w.scene.recetteId, day))).toBe('23514');
    await map(w.owner, c, 'POMPE', null, w.scene.recetteId, later);
    const pick = async (plant: string) =>
      (
        await w.sup<{ id: string | null }>(
          `select (select id::text from public._class_method_recette_in_force($1, 'POMPE', $2, $3::date)) id`,
          [c, plant, later],
        )
      )[0]!.id;
    const forA = await pick(w.plantA);
    const forB = await pick(w.plantB);
    expect(forA).not.toBeNull();
    expect(forB).not.toBeNull();
    expect(forA).not.toBe(forB);
    expect(await code(() => map(w.owner, c, 'BETON', null, w.scene.recetteId, later))).toBe('23514');
    expect(await code(() => map(w.owner, c, 'POMPE', null, randomUUID(), `${later}x`))).toBeDefined();
  });
});
