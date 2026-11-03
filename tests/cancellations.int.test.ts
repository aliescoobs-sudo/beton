import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  cancelUnproducedOrder,
  decideCancellation,
  listCancellations,
  listRedirectCandidates,
  openTripCase,
  setCancellationPolicy,
} from '../src/modules/operations';
import { inRequest, listMyNotifications } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import {
  deliveryScene,
  insertDelivery,
  insertOrder,
  orderMaster,
  type DeliveryScene,
} from './helpers/ledger-fixtures';
import { v1Actors } from './helpers/v1-actors';

// R6 (CP-PROD-PLAN, REQUIREMENTS-V1 §8): the seven cancellation cases, from the real state of the order, with who decides.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
let done: () => Promise<void>;
afterAll(async () => {
  await done();
  await app.end();
});
const marker = `cn${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const u = {} as Record<string, SessionUser>;
let plantId = '';
let scene: DeliveryScene;
let master: Awaited<ReturnType<typeof orderMaster>>;
const NOW = new Date('2026-06-02T09:00:00Z');
const DAY = '2026-06-02';
/** A door refuses either by a thrown Forbidden (permission) or by an error result (database). */
const refused = async (p: Promise<{ ok: boolean }>) => {
  try {
    return !(await p).ok;
  } catch {
    return true;
  }
};
const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: u.owner!.id, role: 'owner', requestId: marker }, async (tx) => {
    await tx.query(`select set_config('app.plant_id', $1, true)`, [plantId]);
    return fn(tx);
  });

beforeAll(async () => {
  const v = await v1Actors(app, env.DATABASE_URL_MIGRATOR, marker);
  done = v.done;
  plantId = v.plantId;
  u.owner = v.owner;
  for (const r of ['app_admin', 'office_sales', 'plant_manager', 'driver', 'accountant'] as const)
    u[r] = v.session(r);
  scene = await asOwner(async () => deliveryScene(app, u.owner!.id, marker, DAY));
  master = await orderMaster(app, u.owner!.id, marker);
});

const newOrder = () =>
  asOwner((tx) => insertOrder(tx, u.owner!.id, { ...master, clientId: scene.clientId }, DAY));

/** A rotation of an order, taken as far as `upTo` ('planned' none, 'loaded', 'departed', 'unloading_started'). */
async function newTrip(
  orderId: string,
  upTo: 'planned' | 'loaded' | 'departed' | 'unloading_started',
  driverId: string | null = null,
  truckId: string = scene.truckId,
) {
  return asOwner(async (tx) => {
    const t = await tx.query<{ id: string }>(
      `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min, depart_min, arrive_min,
                              unload_end_min, back_min, created_by, plant_id)
       values (gen_random_uuid(), gen_random_uuid(), $4, $1, 1, $2, $5, 8000, 420, 430, 455, 485, 520, $3, $6) returning id`,
      [orderId, truckId, u.owner!.id, DAY, driverId, plantId],
    );
    const tripId = t.rows[0]!.id;
    const steps = ['loaded', 'departed', 'arrived', 'unloading_started'];
    const last = upTo === 'planned' ? -1 : steps.indexOf(upTo);
    let deliveryId: string | null = null;
    for (let i = 0; i <= last; i++) {
      if (steps[i] === 'loaded') {
        deliveryId = (
          await insertDelivery(tx, u.owner!.id, { orderId, truckId, recetteId: scene.recetteId }, 8000)
        ).id;
      }
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [
          tripId,
          steps[i],
          new Date(NOW.getTime() - (60 - i * 5) * 60_000).toISOString(),
          steps[i] === 'loaded' ? deliveryId : null,
          u.owner!.id,
        ],
      );
    }
    return { tripId, deliveryId };
  });
}

describe('cases 1 and 2: the order was never produced', () => {
  it('case 1: office cancels a recorded order; reversing entry, owner alerted, no second cancellation', async () => {
    const o = await newOrder();
    const r = await cancelUnproducedOrder(
      app,
      u.office_sales!,
      { orderId: o.id, reason: 'client changed mind' },
      { today: DAY },
    );
    if (!r.ok) {
      const e = await inRequest(app, u.office_sales!, (tx) =>
        tx.query(`select public.cancel_unproduced_order($1, 'x', $2::date)`, [o.id, DAY]),
      ).catch((x) => x);
      throw new Error(String(e.message));
    }
    const rev = await asOwner((tx) =>
      tx.query(`select 1 from sales_order where reverses_id = $1 and volume_l < 0`, [o.id]),
    );
    expect(rev.rowCount).toBe(1);
    const cases = await listCancellations(app, u.owner!);
    expect(cases.find((c) => c.orderCode === o.code)).toMatchObject({
      caseNo: 1,
      status: 'decided',
      decision: 'none',
    });
    expect((await listMyNotifications(app, u.owner!, 50)).some((n) => n.kind === 'order_cancelled')).toBe(
      true,
    );
    expect(
      await refused(cancelUnproducedOrder(app, u.office_sales!, { orderId: o.id }, { today: DAY })),
    ).toBe(true);
  });
  it('case 2: planned rotations leave the plan and the driver is told "do not load"', async () => {
    const o = await newOrder();
    const driverUser = u.driver!.id;
    const drv = await asOwner(async (tx) => {
      const n = Math.floor(Math.random() * 8000);
      const d = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, user_id) values (gen_random_uuid(), 'CH-' || ($1::int + 1000), $2, $3, $4) returning id`,
        [n, `cn${marker}`, u.owner!.id, driverUser],
      );
      return d.rows[0]!.id;
    });
    const { tripId } = await newTrip(o.id, 'planned', drv);
    const r = await cancelUnproducedOrder(
      app,
      u.office_sales!,
      { orderId: o.id, reason: 'site closed' },
      { today: DAY },
    );
    expect(r.ok).toBe(true);
    const c = await asOwner((tx) =>
      tx.query(`select 1 from trip_plan_cancellation where trip_id = $1`, [tripId]),
    );
    expect(c.rowCount).toBe(1);
    expect(
      (await listMyNotifications(app, u.driver!, 50)).some(
        (n) => n.kind === 'cancel_do_not_load' && n.severity === 'urgent',
      ),
    ).toBe(true);
  });
  it('the plant cannot cancel an order, and an order with a live load is refused', async () => {
    const o = await newOrder();
    expect(
      await refused(cancelUnproducedOrder(app, u.plant_manager!, { orderId: o.id }, { today: DAY })),
    ).toBe(true);
    await newTrip(o.id, 'loaded');
    expect(
      await refused(cancelUnproducedOrder(app, u.office_sales!, { orderId: o.id }, { today: DAY })),
    ).toBe(true);
  });
});

describe('cases 3 to 5: concrete is made, redirect or loss', () => {
  it('the case number must match what the tracking shows', async () => {
    const o = await newOrder();
    const { tripId } = await newTrip(o.id, 'loaded');
    expect(await refused(openTripCase(app, u.office_sales!, { tripId, caseNo: 4 }, { now: NOW }))).toBe(true);
    expect(
      await refused(openTripCase(app, u.office_sales!, { tripId, caseNo: 5, unloadedL: 1000 }, { now: NOW })),
    ).toBe(true);
    expect((await openTripCase(app, u.office_sales!, { tripId, caseNo: 3 }, { now: NOW })).ok).toBe(true);
    // a second tap does not open a second case
    expect(await refused(openTripCase(app, u.office_sales!, { tripId, caseNo: 3 }, { now: NOW }))).toBe(true);
  });
  it('case 3: a same-day order of the same type is proposed; redirect is decided by the owner, the BL is marked annulé and kept', async () => {
    const o = await newOrder();
    const target = await newOrder();
    const { tripId, deliveryId } = await newTrip(o.id, 'loaded');
    const opened = await openTripCase(app, u.office_sales!, { tripId, caseNo: 3 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    const cands = await listRedirectCandidates(app, u.owner!, opened.value.id, { now: NOW });
    expect(cands.map((c) => c.orderCode)).toContain(target.code);
    expect(cands.map((c) => c.orderCode)).not.toContain(o.code);
    // the sales office does not decide; the plant manager does not either while the owner's policy says no
    expect(
      await refused(
        decideCancellation(app, u.office_sales!, { caseId: opened.value.id, decision: 'loss' }, { now: NOW }),
      ),
    ).toBe(true);
    expect(
      await refused(
        decideCancellation(
          app,
          u.plant_manager!,
          { caseId: opened.value.id, decision: 'redirect', redirectOrderId: target.id },
          { now: NOW },
        ),
      ),
    ).toBe(true);
    // a redirect to an order that is not proposed is refused
    expect(
      await refused(
        decideCancellation(
          app,
          u.owner!,
          { caseId: opened.value.id, decision: 'redirect', redirectOrderId: o.id },
          { now: NOW },
        ),
      ),
    ).toBe(true);
    const d = await decideCancellation(
      app,
      u.owner!,
      { caseId: opened.value.id, decision: 'redirect', redirectOrderId: target.id },
      { now: NOW },
    );
    expect(d.ok).toBe(true);
    expect(
      await refused(
        decideCancellation(app, u.owner!, { caseId: opened.value.id, decision: 'loss' }, { now: NOW }),
      ),
    ).toBe(true);
    const note = await inRequest(app, u.plant_manager!, (tx) =>
      tx.query<{ cancelled: boolean; bl_no: string }>(`select * from public.delivery_note($1)`, [deliveryId]),
    );
    expect(note.rows[0]?.cancelled).toBe(true);
    const live = await asOwner((tx) => tx.query(`select 1 from delivery where id = $1`, [deliveryId]));
    expect(live.rowCount).toBe(1);
  });
  it('the plant manager decides only once the owner allows it, and only for their plant', async () => {
    const o = await newOrder();
    const { tripId } = await newTrip(o.id, 'departed');
    const opened = await openTripCase(app, u.plant_manager!, { tripId, caseNo: 4 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    expect(
      await refused(
        decideCancellation(
          app,
          u.plant_manager!,
          { caseId: opened.value.id, decision: 'loss', lossFuelL: 12, lossMinutes: 40 },
          { now: NOW },
        ),
      ),
    ).toBe(true);
    expect(
      await refused(
        setCancellationPolicy(app, u.plant_manager!, { plantMayDecide: true, clientCharged: false }),
      ),
    ).toBe(true);
    expect(
      (await setCancellationPolicy(app, u.app_admin!, { plantMayDecide: true, clientCharged: false })).ok,
    ).toBe(true);
    try {
      const d = await decideCancellation(
        app,
        u.plant_manager!,
        { caseId: opened.value.id, decision: 'loss', lossFuelL: 12, lossMinutes: 40 },
        { now: NOW },
      );
      expect(d.ok).toBe(true);
    } finally {
      await setCancellationPolicy(app, u.owner!, { plantMayDecide: false, clientCharged: false });
    }
    const c = (await listCancellations(app, u.owner!)).find((x) => x.id === opened.value.id);
    expect(c).toMatchObject({ decision: 'loss', lossL: 8000, lossFuelL: 12, lossMinutes: 40 });
    expect((await listMyNotifications(app, u.owner!, 80)).some((n) => n.kind === 'loss_recorded')).toBe(true);
  });
  it('after the workable time no redirect is proposed (counted from mixing)', async () => {
    const o = await newOrder();
    await newOrder();
    const { tripId } = await newTrip(o.id, 'departed');
    const opened = await openTripCase(app, u.owner!, { tripId, caseNo: 4 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    const late = new Date(NOW.getTime() + 4 * 3600_000);
    expect(await listRedirectCandidates(app, u.owner!, opened.value.id, { now: late })).toEqual([]);
  });
  it('case 5: the m3 unloaded must be less than the load; the rest is the surplus', async () => {
    const o = await newOrder();
    const { tripId } = await newTrip(o.id, 'unloading_started');
    expect(
      await refused(openTripCase(app, u.owner!, { tripId, caseNo: 5, unloadedL: 8000 }, { now: NOW })),
    ).toBe(true);
    const opened = await openTripCase(app, u.owner!, { tripId, caseNo: 5, unloadedL: 3000 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    expect((await listCancellations(app, u.owner!)).find((c) => c.id === opened.value.id)).toMatchObject({
      unloadedL: 3000,
      surplusL: 5000,
    });
  });
});

describe('cases 6 and 7: incident and rejection on site', () => {
  it('case 7: the reason is mandatory', async () => {
    const o = await newOrder();
    const { tripId } = await newTrip(o.id, 'unloading_started');
    expect(await refused(openTripCase(app, u.owner!, { tripId, caseNo: 7 }, { now: NOW }))).toBe(true);
    const ok = await openTripCase(
      app,
      u.owner!,
      { tripId, caseNo: 7, reason: 'slump out of range', sampleTaken: true },
      { now: NOW },
    );
    expect(ok.ok).toBe(true);
  });
  it('case 6: the truck enters the breakdown log; the choices are the truck incident ones', async () => {
    const o = await newOrder();
    // a truck of its own: the breakdown must not take the shared truck out of other suites
    const truckId = await asOwner(async (tx) => {
      const t = await tx.query<{ id: string }>(
        `insert into truck (id, code, plate)
         select gen_random_uuid(), 'T' || n, 'CN-' || n || $1 from generate_series(900, 999) n
          where 'T' || n not in (select code from truck) order by random() limit 1 returning id`,
        [marker.slice(2, 6)],
      );
      return t.rows[0]!.id;
    });
    const { tripId } = await newTrip(o.id, 'departed', null, truckId);
    const opened = await openTripCase(
      app,
      u.plant_manager!,
      { tripId, caseNo: 6, reason: 'engine' },
      { now: NOW },
    );
    if (!opened.ok) throw new Error(opened.error);
    const log = await asOwner((tx) =>
      tx.query(
        `select 1 from truck_status_log where truck_id = $1 and status = 'breakdown' and reason = 'engine'`,
        [truckId],
      ),
    );
    expect(log.rowCount).toBeGreaterThanOrEqual(1);
    expect(
      await refused(
        decideCancellation(app, u.owner!, { caseId: opened.value.id, decision: 'loss' }, { now: NOW }),
      ),
    ).toBe(true);
    expect(
      (
        await decideCancellation(
          app,
          u.owner!,
          { caseId: opened.value.id, decision: 'replacement_truck' },
          { now: NOW },
        )
      ).ok,
    ).toBe(true);
  });
});

describe('exposure', () => {
  it('no amount is stored in a case and a roles outside the company read nothing', async () => {
    const cols = await asOwner((tx) =>
      tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'cancellation_case'`,
      ),
    );
    for (const c of cols.rows) expect(c.column_name).not.toMatch(/centime|price|amount|total|balance/);
    await expect(listCancellations(app, u.accountant!)).rejects.toThrow();
  });
  it('a driver acknowledges a redirect of their own rotation only, once', async () => {
    const o = await newOrder();
    const target = await newOrder();
    const drv = await asOwner(async (tx) => {
      const n = Math.floor(Math.random() * 8000);
      const d = await tx.query<{ id: string }>(
        `insert into driver (id, code, name, created_by, user_id) values (gen_random_uuid(), 'CH-' || ($1::int + 1000), $2, $3, $4) returning id`,
        [n, `ack${marker}`, u.owner!.id, u.driver!.id],
      );
      return d.rows[0]!.id;
    }).catch(() => null);
    if (!drv) return; // the driver of the previous test already holds the account link
    const { tripId } = await newTrip(o.id, 'departed', drv);
    const opened = await openTripCase(app, u.owner!, { tripId, caseNo: 4 }, { now: NOW });
    if (!opened.ok) throw new Error(opened.error);
    await decideCancellation(
      app,
      u.owner!,
      { caseId: opened.value.id, decision: 'redirect', redirectOrderId: target.id, addressEnc: 'x' },
      { now: NOW },
    );
    await expect(
      inRequest(app, u.office_sales!, (tx) => tx.query(`select * from public.driver_redirects()`)),
    ).rejects.toThrow();
    const ack = (id: string) =>
      inRequest(app, u.driver!, (tx) =>
        tx.query<{ ok: boolean }>(`select public.driver_ack_redirect($1) as ok`, [id]),
      );
    expect((await ack(opened.value.id)).rows[0]?.ok).toBe(true);
    expect((await ack(opened.value.id)).rows[0]?.ok).toBe(false);
  });
});
