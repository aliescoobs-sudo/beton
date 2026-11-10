import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { isTruckAvailable } from '../src/modules/master-data';
import {
  createDriver,
  getDispatchDay,
  listDrivers,
  planDispatch,
  saveDispatch,
} from '../src/modules/operations';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import { deliveryScene, type DeliveryScene } from './helpers/ledger-fixtures';

// operations O9: the daily dispatch. AC-OPS-12 (a truck in the log is never planned, by service and database), AC-OPS-15
// (insert-only, replanning cancels with a reason, who may read and write, no money), the SQL twin of truck availability.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const users = {} as Record<'owner' | 'partner' | 'plant' | 'office' | 'support', SessionUser>;
const marker = `dp${randomUUID().replace(/-/g, '').slice(0, 10)}`;
/** The date of every fixture order (tests/helpers/ledger-fixtures.ts insertOrder). */
const DAY = '2026-06-02';
let scene: DeliveryScene;
let driverId: string;

const asOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, fn);

/** A truck of its own (code T + 3 digits, retried on a clash) so the breakdown logs here never touch the pilot's trucks. */
async function newTruck(capacityL = 8000): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = `T${100 + Math.floor(Math.random() * 899)}`;
    try {
      return await asOwner(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into truck (id, code, plate, capacity_l) values (gen_random_uuid(), $1, $2, $3) returning id`,
          [code, `${code}-${marker.slice(0, 8)}-${i}`, capacityL],
        );
        return r.rows[0]?.id as string;
      });
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  throw new Error('no free truck code');
}

const logTruck = (truckId: string, status: string, from: string, to: string | null, createdAt?: string) =>
  asOwner((tx) =>
    tx.query(
      `insert into truck_status_log (id, truck_id, status, from_date, to_date, reason, logged_by, created_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'test', $5, coalesce($6::timestamptz, now()))`,
      [truckId, status, from, to, users.owner.id, createdAt ?? null],
    ),
  );

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'plant', 'office', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  scene = await deliveryScene(app, users.owner.id, marker);
  const d = await createDriver(app, users.owner, { name: `Driver ${marker}` });
  if (!d.ok) throw new Error(d.error);
  driverId = d.value.id;
});

const rotation = (truckId: string, volumeL: number, driver: string | null = driverId) => ({
  orderId: scene.orderId,
  truckId,
  driverId: driver,
  volumeL,
});

describe('who may read and write the plan (AC-OPS-15)', () => {
  it('owner and plant read the day; office, partner and support are refused (T8)', async () => {
    for (const role of ['partner', 'support'] as const)
      await expect(getDispatchDay(app, users[role], DAY), role).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ['owner', 'plant'] as const) {
      const day = await getDispatchDay(app, users[role], DAY);
      expect(day.ok, role).toBe(true);
      if (day.ok) expect(day.value.orders.some((o) => o.orderId === scene.orderId)).toBe(true);
    }
    await expect(getDispatchDay(app, users.office, DAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('support, partner and office cannot save a plan; plant and owner can', async () => {
    for (const role of ['support', 'office', 'partner'] as const) {
      await expect(
        saveDispatch(app, users[role], { date: DAY, rotations: [rotation(scene.truckId, 1000)] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const role of ['plant', 'owner'] as const) {
      const saved = await saveDispatch(app, users[role], {
        date: DAY,
        rotations: [rotation(scene.truckId, 1000)],
      });
      expect(saved.ok, role).toBe(true);
    }
  });

  it('the response carries no price, total, client contact or payment', async () => {
    for (const role of ['plant', 'owner'] as const) {
      const day = await getDispatchDay(app, users[role], DAY);
      expectNoFields(day, [
        'priceCentimes',
        'unitPriceHtCentimes',
        'unit_price_ht_centimes',
        'totalTtcCentimes',
        'total_ttc_centimes',
        'amountCentimes',
        'phone',
        'clientName',
        'planItems',
      ]);
    }
  });

  it('only the owner adds drivers; the code is the next free CH-nn', async () => {
    await expect(createDriver(app, users.plant, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    const a = await createDriver(app, users.owner, { name: `A ${marker}` });
    const b = await createDriver(app, users.owner, { name: `B ${marker}` });
    if (!a.ok || !b.ok) throw new Error('driver');
    expect(a.value.code).toMatch(/^CH-\d{2,}$/);
    expect(Number(b.value.code.slice(3))).toBe(Number(a.value.code.slice(3)) + 1);
    // (a plant account bound to no plant reads the roster; a plant MANAGER only his plant's drivers: tests/t10a-isolation.int.test.ts)
    expect((await listDrivers(app, users.plant)).some((d) => d.id === a.value.id)).toBe(true);
    expect((await listDrivers(app, users.owner)).some((d) => d.id === a.value.id)).toBe(true);
    expect(await createDriver(app, users.owner, { name: '   ' })).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('overdue orders are planned with the day (from today on)', () => {
  it('on the business day an order due earlier and still to load is listed with its due date; on a past day it is not', async () => {
    const today = await getDispatchDay(app, users.plant, '2026-06-05', { today: '2026-06-05' });
    if (!today.ok) throw new Error('day');
    const late = today.value.orders.find((o) => o.orderId === scene.orderId);
    expect(late).toMatchObject({ dueDate: DAY });
    // a day before the business day is history: only the orders due that day
    const past = await getDispatchDay(app, users.plant, '2026-06-05', { today: '2026-06-09' });
    if (!past.ok) throw new Error('day');
    expect(past.value.orders.some((o) => o.orderId === scene.orderId)).toBe(false);
    // without the business day nothing overdue is added either
    const bare = await getDispatchDay(app, users.plant, '2026-06-05');
    if (!bare.ok) throw new Error('day');
    expect(bare.value.orders.some((o) => o.orderId === scene.orderId)).toBe(false);
  });
});

describe('a truck that cannot be planned (AC-OPS-12)', () => {
  it('a truck in the breakdown log on the day is refused by the service and by the database, and is not available in the day', async () => {
    const truckId = await newTruck();
    await logTruck(truckId, 'breakdown', DAY, '2026-06-03');
    const day = await getDispatchDay(app, users.plant, DAY);
    if (!day.ok) throw new Error('day');
    expect(day.value.trucks.find((t) => t.id === truckId)?.available).toBe(false);
    const proposal = planDispatch(day.value.orders, day.value.trucks, day.value.drivers, day.value.params);
    expect(proposal.rotations.every((r) => r.truckId !== truckId)).toBe(true);

    expect(await saveDispatch(app, users.plant, { date: DAY, rotations: [rotation(truckId, 1000)] })).toEqual(
      {
        ok: false,
        error: 'BLOCKED',
      },
    );
    // direct SQL, as the plant: the guard refuses, with no amount in the message
    await expect(
      withRlsContext(app, { userId: users.plant.id, role: 'plant', requestId: marker }, (tx) =>
        tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min,
                                  arrive_min, unload_end_min, back_min, created_by)
           values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, 1000, 420, 430, 455, 485, 520, $4)`,
          [DAY, scene.orderId, truckId, users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('not available') });
    // the day after the breakdown the truck is back
    await logTruck(truckId, 'available', '2026-06-03', null);
    const next = await getDispatchDay(app, users.plant, '2026-06-03');
    if (!next.ok) throw new Error('day');
    expect(next.value.trucks.find((t) => t.id === truckId)?.available).toBe(true);
  });

  it('a rotation over the truck is refused by the service and by the database', async () => {
    const small = await newTruck(5000);
    expect(await saveDispatch(app, users.plant, { date: DAY, rotations: [rotation(small, 5001)] })).toEqual({
      ok: false,
      error: 'BLOCKED',
    });
    await expect(
      withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, volume_l, load_min, depart_min,
                                  arrive_min, unload_end_min, back_min, created_by)
           values (gen_random_uuid(), gen_random_uuid(), $1, $2, 1, $3, 5001, 420, 430, 455, 485, 520, $4)`,
          [DAY, scene.orderId, small, users.owner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('more than the truck') });
  });

  it('an archived driver and a cancelled order cannot be planned', async () => {
    const archived = await createDriver(app, users.owner, { name: `Gone ${marker}` });
    if (!archived.ok) throw new Error('driver');
    await asOwner((tx) =>
      tx.query(`update driver set status = 'archived' where id = $1`, [archived.value.id]),
    );
    expect(
      await saveDispatch(app, users.owner, {
        date: DAY,
        rotations: [rotation(scene.truckId, 1000, archived.value.id)],
      }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('saving and replanning (AC-OPS-15)', () => {
  it('writes the rotations with times from the parameters, and replanning cancels the earlier ones with a reason', async () => {
    const date = DAY;
    const first = await saveDispatch(app, users.plant, {
      date,
      rotations: [rotation(scene.truckId, 8000), rotation(scene.truckId, 2000)],
    });
    if (!first.ok) throw new Error(first.error);
    const live = async () =>
      (
        await asOwner((tx) =>
          tx.query<{ n: string }>(
            `select count(*)::text as n from trip_plan p where p.batch_id = $1
              and not exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id)`,
            [first.value.batchId],
          ),
        )
      ).rows[0]?.n;
    expect(await live()).toBe('2');
    const rows = await migrator.query<{
      seq: number;
      load_min: number;
      depart_min: number;
      back_min: number;
    }>(`select seq, load_min, depart_min, back_min from trip_plan where batch_id = $1 order by seq`, [
      first.value.batchId,
    ]);
    // the second rotation of the truck starts when the first is back
    expect(rows.rows[1]?.load_min).toBe(rows.rows[0]?.back_min);
    expect(rows.rows[0]?.depart_min).toBe((rows.rows[0]?.load_min ?? 0) + 10);

    const second = await saveDispatch(app, users.plant, {
      date,
      rotations: [rotation(scene.truckId, 8000)],
    });
    if (!second.ok) throw new Error(second.error);
    expect(await live()).toBe('0');
    const reasons = await asOwner((tx) =>
      tx.query<{ reason: string }>(
        `select c.reason from trip_plan_cancellation c join trip_plan p on p.id = c.trip_id where p.batch_id = $1`,
        [first.value.batchId],
      ),
    );
    expect(reasons.rows.map((r) => r.reason)).toEqual(['replanned', 'replanned']);
  });

  it('the plan tables have no UPDATE or DELETE for the application role', async () => {
    for (const table of ['trip_plan', 'trip_plan_cancellation']) {
      const { rows } = await migrator.query<{ u: boolean; d: boolean }>(
        `select has_table_privilege('belgobeton_app', $1, 'UPDATE') as u, has_table_privilege('belgobeton_app', $1, 'DELETE') as d`,
        [`public.${table}`],
      );
      expect(rows[0], table).toEqual({ u: false, d: false });
    }
  });

  it('the plan shows the order, client code and truck, never a name or a price', async () => {
    const day = await getDispatchDay(app, users.plant, DAY);
    if (!day.ok) throw new Error('day');
    const row = day.value.saved.find((s) => s.orderId === scene.orderId);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'arriveMin',
        'backMin',
        'clientCode',
        'departMin',
        'driverId',
        'driverName',
        'foreign', // T8: a boolean (another plant's rotation, not planned by this account); no name, no price
        'key',
        'loadMin',
        'orderCode',
        'orderId',
        'overrideReason',
        'seq',
        'started',
        'truckCode',
        'truckId',
        'unloadEndMin',
        'volumeL',
      ].sort(),
    );
  });
});

describe('truck_available_on is the SQL twin of isTruckAvailable (property)', () => {
  it('agrees with the TypeScript function on random logs', async () => {
    const entry = fc.record({
      status: fc.constantFrom('available', 'breakdown', 'roadblock'),
      from: fc.integer({ min: 0, max: 20 }),
      len: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
    });
    const dayOf = (n: number) => new Date(Date.UTC(2031, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
    // Each case uses a fresh truck so logs never mix.
    await fc.assert(
      fc.asyncProperty(fc.array(entry, { maxLength: 4 }), async (entries) => {
        const id = await newTruck();
        const logged: Parameters<typeof isTruckAvailable>[2][number][] = [];
        let n = 0;
        for (const e of entries) {
          const from = dayOf(e.from);
          const to = e.len === null ? null : dayOf(e.from + e.len);
          const createdAt = new Date(Date.UTC(2031, 0, 1, 0, 0, n++)).toISOString();
          await logTruck(id, e.status, from, to, createdAt);
          logged.push({
            id: String(n).padStart(8, '0'),
            truckId: id,
            status: e.status,
            fromDate: from,
            toDate: to,
            reason: 'test',
            createdAt,
          });
        }
        for (let d = 0; d < 32; d += 3) {
          const date = dayOf(d);
          const { rows } = await migrator.query<{ ok: boolean }>(
            `select public.truck_available_on($1, $2) as ok`,
            [id, date],
          );
          expect(rows[0]?.ok, `${date} ${JSON.stringify(entries)}`).toBe(
            isTruckAvailable({ status: 'active' }, date, logged),
          );
        }
      }),
      { numRuns: 12 },
    );
  }, 120_000);

  it('an archived truck is never available', async () => {
    const id = await newTruck();
    await asOwner((tx) => tx.query(`update truck set status = 'archived' where id = $1`, [id]));
    const { rows } = await migrator.query<{ ok: boolean }>(`select public.truck_available_on($1, $2) as ok`, [
      id,
      DAY,
    ]);
    expect(rows[0]?.ok).toBe(false);
  });
});
