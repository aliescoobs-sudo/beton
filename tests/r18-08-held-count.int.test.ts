import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countHeldDeliveries } from '../src/modules/operations';
import { testEnv } from './db-env';
import { plantWorld, type World } from './helpers/plant-world';

/**
 * R18-08: the held-delivery count has its own query. Equal counts for equal holds however much irrelevant detail exists (including volume sums beyond the
 * integer range), no error from hidden branches, the internal detail reader still closed, every role's answer, NULL scope with a positive fixture, the bound.
 */
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const marker = `r8${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let w: World;
const isoDay = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const range = (from: number, to: number) => ({ from: isoDay(from), to: isoDay(to) });
const countAs = (u: { id: string; role: string }, r: { from: string; to: string }) =>
  w.as(
    u,
    async (tx) =>
      (await tx.query<{ n: number }>('select public.trip_delivery_held_count($1, $2) as n', [r.from, r.to]))
        .rows[0]!.n,
  );

beforeAll(async () => {
  w = await plantWorld(app, migrator, marker);
});
afterAll(async () => {
  await w.done();
  await Promise.all([app.end(), migrator.end()]);
});

/** A rotation the driver took to the end of the unloading; `linked` gives it the plant's load (then it is "unconfirmed" once the day's confirm time passed). */
async function declared(
  plant: string,
  truck: string,
  row: string,
  user: never,
  day: string,
  opts: { linked: boolean; nullPlant?: boolean },
) {
  const t = await w.newTrip(plant, truck, row, { day, nullPlant: opts.nullPlant });
  await w.tap(user, t.trip, 'loaded');
  let load: string | null = null;
  if (opts.linked) {
    load = await w.plantLoad(opts.nullPlant ? w.plantA : plant, t.order, truck);
    if (opts.nullPlant)
      await w.sup(`update delivery set plant_id = null where id = $1`, [load], ['delivery']);
    await w.as(w.owner, (tx) => tx.query('select public.attach_trip_load($1, $2)', [t.trip, load]));
  }
  for (const s of ['departed', 'arrived', 'unloading_started']) await w.tap(user, t.trip, s);
  await w.tap(user, t.trip, 'unloading_finished', 1000);
  return { ...t, load };
}

describe('R18-08: the count runs its own query', () => {
  it('equal holds give equal counts whatever irrelevant detail exists: mismatching volumes, order totals beyond the integer range, gated trips', async () => {
    const r = range(9, 7);
    const d1 = isoDay(9);
    const d2 = isoDay(8);
    const base = await countAs(w.owner, r);
    // two holds in the window: one with no plant load (declared_no_record), one with a load and no gate (unconfirmed, the day's confirm time has passed)
    await declared(w.plantA, w.truckA, w.driverA, w.driverUserA as never, d1, { linked: false });
    await declared(w.plantA, w.truckA, w.driverA, w.driverUserA as never, d2, { linked: true });
    const n0 = await countAs(w.owner, r);
    expect(n0).toBe(base + 2);
    // irrelevant detail 1: a gated trip whose declared volume, plan and order disagree (volume_differs / order_differs material)
    const d3 = isoDay(7);
    const gated = await declared(w.plantA, w.truckA, w.driverA, w.driverUserA as never, d3, { linked: true });
    await w.as(w.owner, (tx) => tx.query('select public.confirm_trip_delivered($1)', [gated.trip]));
    // irrelevant detail 2: loads on that order whose volumes add up beyond the integer range (the old count cast this sum to integer and failed)
    // (bare loads of the order, made by hand: no stock, to keep the fixture small — the point is the SUM, not the stock)
    for (let i = 0; i < 3; i++)
      await w.sup(
        `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, loaded_at, recette_id, plant_id, created_by)
         values (gen_random_uuid(), $5, $1, $2, 1000000000, '2026-06-01', now(), $3, $6, $4)`,
        [
          gated.order,
          w.truckA,
          w.scene.recetteId,
          w.owner.id,
          `BL-2098-9${String(i).padStart(1, '0')}${String(Date.now()).slice(-6)}`,
          w.plantA,
        ],
        ['delivery', 'stock_movement'],
      );
    const sum = (
      await w.sup<{ s: string }>(
        `select coalesce(sum(volume_l), 0)::text s from delivery where order_id = $1`,
        [gated.order],
      )
    )[0]!.s;
    expect(Number(sum)).toBeGreaterThan(2_147_483_647);
    // the count did not move, did not fail, and every role that may ask gets the same number
    expect(await countAs(w.owner, r)).toBe(n0);
    expect(await countAs(w.appAdmin, r)).toBe(n0);
    expect(await countAs(w.sales, r)).toBe(n0);
    const viaService = await countHeldDeliveries(app, w.sales, r);
    expect(viaService).toEqual({ ok: true, value: n0 });
    // the details reader (owner) is not what the count calls: it may be expensive or fail on this data; the count must not care
    void (await w.as(w.owner, (tx) => tx.query('select 1')));
  });

  it('the internal detail reader stays closed to the application login; the office keeps no access to the details', async () => {
    const r = range(9, 7);
    for (const who of [w.owner, w.sales, w.pmA]) {
      const err = await w.failure(
        { user: who.id, role: who.role },
        'select * from public.trip_delivery_exceptions_internal($1, $2, true)',
        [r.from, r.to],
      );
      expect(err?.code, who.role).toBe('42501');
    }
    for (const who of [w.sales, w.purchases])
      expect(
        (
          await w.failure(
            { user: who.id, role: who.role },
            'select * from public.trip_delivery_exceptions($1, $2)',
            [r.from, r.to],
          )
        )?.code,
        who.role,
      ).toBe('42501');
  });

  it('plain office roles count every plant AND a plantless hold (a positive fixture with NULL scope); plant managers only their own; reserved roles, drivers, the accountant and a missing actor are refused', async () => {
    const day = isoDay(5);
    const r = range(5, 5);
    const none = await countAs(w.owner, r);
    const a = await declared(w.plantA, w.truckA, w.driverA, w.driverUserA as never, day, { linked: false });
    const b = await declared(w.plantB, w.truckB, w.driverB, w.driverUserB as never, day, { linked: false });
    const n = await declared(w.plantA, w.truckN, w.driverA, w.driverUserA as never, day, {
      linked: false,
      nullPlant: true,
    });
    void [a, b, n];
    expect(await countAs(w.owner, r)).toBe(none + 3);
    expect(await countAs(w.sales, r)).toBe(none + 3); // office: every plant and the plantless one
    expect(await countAs(w.purchases, r).catch(() => 'refused')).toBe('refused'); // office_purchases does not work the queue
    // a manager counts his plant's only: A has one hold of his own (the plantless one is nobody's plant)
    expect(await countAs(w.pmA, r)).toBe(1);
    expect(await countAs(w.pmB, r)).toBe(1);
    for (const who of [w.partner, w.support, w.accountant, w.driverUserA])
      expect(
        (
          await w.failure(
            { user: who.id, role: who.role },
            'select public.trip_delivery_held_count($1, $2)',
            [r.from, r.to],
          )
        )?.code,
        who.role,
      ).toBe('42501');
    expect(
      (
        await w.failure({ user: w.pmA.id, role: null }, 'select public.trip_delivery_held_count($1, $2)', [
          r.from,
          r.to,
        ])
      )?.code,
    ).toBe('42501');
    expect(
      (
        await w.failure({ user: null, role: null }, 'select public.trip_delivery_held_count($1, $2)', [
          r.from,
          r.to,
        ])
      )?.code,
    ).toBe('42501');
  });

  it('the range is bounded: at most 62 days, from before to; both the database and the service refuse more', async () => {
    const wide = range(70, 0);
    expect(
      (
        await w.failure(
          { user: w.owner.id, role: 'owner' },
          'select public.trip_delivery_held_count($1, $2)',
          [wide.from, wide.to],
        )
      )?.code,
    ).toBe('23514');
    expect(
      (
        await w.failure(
          { user: w.owner.id, role: 'owner' },
          'select public.trip_delivery_held_count($1, $2)',
          [isoDay(1), isoDay(3)],
        )
      )?.code,
    ).toBe('23514');
    expect(
      (
        await w.failure(
          { user: w.owner.id, role: 'owner' },
          'select public.trip_delivery_held_count(null, $1)',
          [isoDay(3)],
        )
      )?.code,
    ).toBe('23514');
    expect(await countHeldDeliveries(app, w.sales, wide)).toEqual({ ok: false, error: 'INVALID' });
    expect(await countHeldDeliveries(app, w.sales, { from: isoDay(1), to: isoDay(3) })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    const edge = range(62, 0);
    expect(typeof (await countAs(w.owner, edge))).toBe('number');
  });
});
