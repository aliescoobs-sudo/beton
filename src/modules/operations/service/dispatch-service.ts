import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from '@/modules/ledger';
import { isTruckAvailable } from '@/modules/master-data';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import {
  checkDispatch,
  type Conflict,
  type DispatchDriver,
  type DispatchOrder,
  type DispatchParams,
  type DispatchTruck,
  isBlocking,
  retime,
  type Rotation,
} from '../domain/dispatch';
import { parseDispatchInput, parseDriverInput } from '../domain/load-input';
import { opsParameter } from './ops-parameters';

export type DispatchError =
  'INVALID' | 'NOT_FOUND' | 'BLOCKED' | 'TRUCK_UNAVAILABLE' | 'OVER_CAPACITY' | 'CONFLICT';

export function dispatchFailure(error: unknown): DispatchError {
  const e = error as { code?: string; message?: string };
  const m = e.message ?? '';
  if (e.code === '23514') {
    if (/truck is not available/.test(m)) return 'TRUCK_UNAVAILABLE';
    if (/more than the truck/.test(m)) return 'OVER_CAPACITY';
    if (/not a live order|driver is not active/.test(m)) return 'NOT_FOUND';
    return 'INVALID';
  }
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (isUniqueViolation(error) || e.code === '40001' || e.code === '40P01') return 'CONFLICT';
  throw error;
}

/** A rotation saved in the plan, with the words a screen needs. Quantities and times only. */
export interface SavedRotation extends Rotation {
  orderCode: string;
  clientCode: string;
  truckCode: string;
  driverName: string | null;
}

export interface DispatchDay {
  date: string;
  params: DispatchParams;
  orders: DispatchOrder[];
  trucks: DispatchTruck[];
  drivers: DispatchDriver[];
  /** The live rotations saved for the day (not cancelled). */
  saved: SavedRotation[];
}

export async function readDispatchParams(tx: pg.PoolClient): Promise<DispatchParams> {
  return {
    dayStartMin: await opsParameter(tx, 'day_start_min'),
    loadingMin: await opsParameter(tx, 'loading_min'),
    unloadingMin: await opsParameter(tx, 'unloading_min'),
    returnExtraMin: await opsParameter(tx, 'return_extra_min'),
    workingMin: await opsParameter(tx, 'working_min'),
    concreteLimitMin: await opsParameter(tx, 'concrete_limit_min'),
    defaultOneWayMin: await opsParameter(tx, 'default_one_way_min'),
  };
}

/** The live orders due on `date` with what is still to load, in code order. */
async function dayOrders(tx: pg.PoolClient, date: string): Promise<DispatchOrder[]> {
  const { rows } = await tx.query<{
    id: string;
    code: string;
    client_code: string;
    type_label: string;
    site_label: string | null;
    zone_name: string | null;
    one_way_min: number | null;
    volume_l: number;
    loaded_l: string;
  }>(
    `select o.id, o.code, o.client_code, t.label as type_label, o.site_label, z.name as zone_name, z.one_way_min,
            o.volume_l, coalesce((select sum(d.volume_l) from delivery d where d.order_id = o.id), 0)::text as loaded_l
       from sales_order_ops o
       join concrete_type t on t.id = o.concrete_type_id
       left join zone z on z.id = o.zone_id
      where o.reverses_id is null and not o.is_reversed and o.delivery_date = $1
      order by o.code`,
    [date],
  );
  return rows
    .map((r) => ({
      orderId: r.id,
      orderCode: r.code,
      clientCode: r.client_code,
      typeLabel: r.type_label,
      siteLabel: r.site_label,
      zoneName: r.zone_name,
      oneWayMin: r.one_way_min,
      remainingL: Math.max(0, r.volume_l - Number(r.loaded_l)),
    }))
    .filter((o) => o.remainingL > 0);
}

async function dayTrucks(tx: pg.PoolClient, date: string): Promise<DispatchTruck[]> {
  const trucks = await tx.query<{
    id: string;
    code: string;
    capacity_l: number;
    status: 'active' | 'archived';
  }>(`select id, code, capacity_l, status from truck order by code`);
  const log = await tx.query<{
    id: string;
    truck_id: string;
    status: 'available' | 'breakdown' | 'roadblock';
    from_date: string;
    to_date: string | null;
    reason: string;
    created_at: Date;
  }>(
    `select id, truck_id, status, to_char(from_date, 'YYYY-MM-DD') as from_date, to_char(to_date, 'YYYY-MM-DD') as to_date,
            reason, created_at
       from truck_status_log order by created_at, id`,
  );
  return trucks.rows
    .map((t) => ({
      id: t.id,
      code: t.code,
      capacityL: t.capacity_l,
      available: isTruckAvailable(
        { status: t.status },
        date,
        log.rows
          .filter((l) => l.truck_id === t.id)
          .map((l) => ({
            id: l.id,
            truckId: l.truck_id,
            status: l.status,
            fromDate: l.from_date,
            toDate: l.to_date,
            reason: l.reason,
            createdAt: l.created_at.toISOString(),
          })),
      ),
    }))
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

async function activeDrivers(tx: pg.PoolClient): Promise<DispatchDriver[]> {
  const { rows } = await tx.query<DispatchDriver>(
    `select id, code, name from driver where status = 'active' order by code`,
  );
  return rows;
}

async function liveRotations(tx: pg.PoolClient, date: string): Promise<SavedRotation[]> {
  const { rows } = await tx.query<{
    id: string;
    order_id: string;
    seq: number;
    truck_id: string;
    driver_id: string | null;
    volume_l: number;
    load_min: number;
    depart_min: number;
    arrive_min: number;
    unload_end_min: number;
    back_min: number;
    order_code: string;
    client_code: string;
    truck_code: string;
    driver_name: string | null;
  }>(
    `select p.id, p.order_id, p.seq, p.truck_id, p.driver_id, p.volume_l, p.load_min, p.depart_min, p.arrive_min,
            p.unload_end_min, p.back_min, o.code as order_code, o.client_code, t.code as truck_code, d.name as driver_name
       from trip_plan p
       join sales_order_ops o on o.id = p.order_id
       join truck t on t.id = p.truck_id
       left join driver d on d.id = p.driver_id
      where p.trip_date = $1 and not exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id)
      order by p.load_min, o.code, p.seq`,
    [date],
  );
  return rows.map((r) => ({
    key: r.id,
    orderId: r.order_id,
    seq: r.seq,
    truckId: r.truck_id,
    driverId: r.driver_id,
    volumeL: r.volume_l,
    loadMin: r.load_min,
    departMin: r.depart_min,
    arriveMin: r.arrive_min,
    unloadEndMin: r.unload_end_min,
    backMin: r.back_min,
    orderCode: r.order_code,
    clientCode: r.client_code,
    truckCode: r.truck_code,
    driverName: r.driver_name,
  }));
}

/** Everything the dispatch screen needs for a day: the orders to load, the trucks (available or not), the drivers, the saved plan. */
export async function getDispatchDay(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
): Promise<Result<DispatchDay, 'INVALID'>> {
  await require(appPool, actor, 'dispatch.read');
  if (!isRealDate(date)) return err('INVALID');
  return ok(
    await inRequest(appPool, actor, async (tx) => ({
      date,
      params: await readDispatchParams(tx),
      orders: await dayOrders(tx, date),
      trucks: await dayTrucks(tx, date),
      drivers: await activeDrivers(tx),
      saved: await liveRotations(tx, date),
    })),
  );
}

export interface SavedDispatch {
  batchId: string;
  rotations: number;
  /** What the plan still has wrong that the database does not refuse (shown, never silent). */
  conflicts: Conflict[];
}

/**
 * A person saves a day's plan (D65): the rotations are re-timed from the parameters in force, judged by the same rules as
 * the screen, written insert-only, and the day's earlier live rotations are cancelled as `replanned`. A truck that is not
 * available that day, or a rotation over its truck, is refused (here and by the database); the other conflicts are
 * returned and kept visible.
 */
export async function saveDispatch(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<SavedDispatch, DispatchError>> {
  await require(appPool, actor, 'dispatch.write');
  const parsed = parseDispatchInput(input);
  if (!parsed.ok) return err('INVALID');
  const { date, rotations: wanted } = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<SavedDispatch, DispatchError>> => {
      const params = await readDispatchParams(tx);
      const orders = await dayOrders(tx, date);
      const trucks = await dayTrucks(tx, date);
      const drivers = await activeDrivers(tx);
      const previous = await liveRotations(tx, date);
      // Orders already fully loaded drop out of `orders`; a plan for one of them is for an order with nothing left.
      const known = new Set(orders.map((o) => o.orderId));
      if (wanted.some((w) => !known.has(w.orderId))) return err('NOT_FOUND');
      const seq = new Map<string, number>();
      const draft: Rotation[] = wanted.map((w, i) => {
        const n = (seq.get(w.orderId) ?? 0) + 1;
        seq.set(w.orderId, n);
        return {
          key: `r${i}`,
          orderId: w.orderId,
          seq: n,
          truckId: w.truckId,
          driverId: w.driverId ?? null,
          volumeL: w.volumeL,
          // Input order is the loading order inside a truck; `retime` turns it into minutes.
          loadMin: i,
          departMin: i,
          arriveMin: i,
          unloadEndMin: i,
          backMin: i,
        };
      });
      const timed = retime(draft, orders, params);
      const conflicts = checkDispatch(timed, { orders, trucks, drivers, params });
      if (conflicts.some(isBlocking)) return err('BLOCKED');

      const batchId = randomUUID();
      for (const p of previous) {
        await tx.query(
          `insert into trip_plan_cancellation (id, trip_id, reason, created_by) values ($1, $2, 'replanned', $3)`,
          [randomUUID(), p.key, actor.id],
        );
      }
      for (const r of timed) {
        await tx.query(
          `insert into trip_plan (id, batch_id, trip_date, order_id, seq, truck_id, driver_id, volume_l, load_min,
                                  depart_min, arrive_min, unload_end_min, back_min, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            randomUUID(),
            batchId,
            date,
            r.orderId,
            r.seq,
            r.truckId,
            r.driverId,
            r.volumeL,
            r.loadMin,
            r.departMin,
            r.arriveMin,
            r.unloadEndMin,
            r.backMin,
            actor.id,
          ],
        );
      }
      return ok({ batchId, rotations: timed.length, conflicts });
    });
  } catch (error) {
    return err(dispatchFailure(error));
  }
}

export interface DriverRow {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'archived';
}

export async function listDrivers(appPool: pg.Pool, actor: SessionUser): Promise<DriverRow[]> {
  await require(appPool, actor, 'dispatch.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<DriverRow>(`select id, code, name, status from driver order by code`),
  );
  return rows;
}

/** A manager adds a driver; the code CH-nn is the next free one (a lock keeps two additions from taking the same). */
export async function createDriver(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<DriverRow, 'INVALID' | 'CONFLICT'>> {
  await require(appPool, actor, 'drivers.write');
  const parsed = parseDriverInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    return ok(
      await inRequest(appPool, actor, async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtextextended('driver:code', 0))`);
        const next = await tx.query<{ n: number }>(
          `select coalesce(max(substr(code, 4)::int), 0) + 1 as n from driver`,
        );
        const code = `CH-${String(next.rows[0]?.n ?? 1).padStart(2, '0')}`;
        const { rows } = await tx.query<DriverRow>(
          `insert into driver (id, code, name, created_by) values ($1, $2, $3, $4) returning id, code, name, status`,
          [randomUUID(), code, parsed.value.name, actor.id],
        );
        return rows[0] as DriverRow;
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) return err('CONFLICT');
    throw error;
  }
}

export async function archiveDriver(
  appPool: pg.Pool,
  actor: SessionUser,
  driverId: string,
): Promise<Result<true, 'NOT_FOUND'>> {
  await require(appPool, actor, 'drivers.write');
  try {
    const { rowCount } = await inRequest(appPool, actor, (tx) =>
      tx.query(`update driver set status = 'archived' where id = $1 and status = 'active'`, [driverId]),
    );
    return rowCount ? ok(true as const) : err('NOT_FOUND');
  } catch (error) {
    if (isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
