import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { type Effect, nextDocNumber, visibleEffects } from '@/modules/ledger';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { consumptionForLoad } from '../domain/consumption';
import {
  type LoadInput,
  parseBlReturnInput,
  parseCancelLoadInput,
  parseLoadInput,
} from '../domain/load-input';
import { remainingVolume } from '../domain/stock';
import { tripExceedsLimit } from '../domain/trip';
import { stockEffects } from './effects';
import { opsParameter } from './ops-parameters';

export type DeliveryError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'ORDER_CANCELLED'
  | 'TRUCK_UNAVAILABLE'
  | 'OVER_CAPACITY'
  | 'OVER_ORDER'
  | 'NO_RECETTE'
  | 'ALREADY_RETURNED'
  | 'ALREADY_DELIVERED'
  | 'FOLLOWS_ROTATION'
  | 'CONFLICT';

export function deliveryFailure(error: unknown): DeliveryError {
  const e = error as { code?: string; message?: string };
  const m = e.message ?? '';
  if (e.code === '23514') {
    if (/order is cancelled/.test(m)) return 'ORDER_CANCELLED';
    if (/truck is not available/.test(m)) return 'TRUCK_UNAVAILABLE';
    if (/more than the truck/.test(m)) return 'OVER_CAPACITY';
    if (/left to deliver/.test(m)) return 'OVER_ORDER';
    if (/recette in force/.test(m)) return 'NO_RECETTE';
    if (/unknown|not a live load/.test(m)) return 'NOT_FOUND';
    return 'INVALID';
  }
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (isUniqueViolation(error) || e.code === '40001' || e.code === '40P01') return 'CONFLICT';
  throw error;
}

export interface CreatedLoad {
  id: string;
  blNo: string;
  volumeL: number;
  /**
   * `LONG_TRIP`: the trip plus the unloading is more than the concrete's workable time (R4). `OVER_ORDER`: the order is now
   * loaded past its volume, `OVER_ORDER_MINOR` when the excess is within the tolerance. Warnings, never a refusal.
   */
  warnings: ('LONG_TRIP' | 'OVER_ORDER' | 'OVER_ORDER_MINOR')[];
  /** Litres of this load that go past the order volume (0 when none): recorded for the owner to confirm. */
  excessL: number;
  /** What the load changed: the BL, what is left of the order, the stock of every component. Filtered by role. */
  effects: Effect[];
}

const loadedNow = (before: number | undefined, volumeL: number): number => Number(before ?? 0) + volumeL;

/** The excess over the order volume is "minor" when it is within `toleranceBp` of that volume (parameter). */
export function withinTolerance(orderVolumeL: number, loadedL: number, toleranceBp: number): boolean {
  return (loadedL - orderVolumeL) * 10_000 <= toleranceBp * orderVolumeL;
}

/**
 * The recette in force for a type, a plant and a business date: the plant's own latest started version, else the
 * all-plants one (the database function `recette_in_force`, the same one the load guard uses), or null.
 */
export async function recetteInForce(
  tx: pg.PoolClient,
  concreteTypeId: string,
  date: string,
  plantId: string | null = null,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string | null }>(`select public.recette_in_force($1, $2, $3) as id`, [
    concreteTypeId,
    plantId,
    date,
  ]);
  return rows[0]?.id ?? null;
}

/**
 * One truck load for an order (AC-OPS-01): the load is within the truck and within what is left of the order, the recette
 * in force on `deps.today` is stored on it, it gets its BL number. Plant, owner and partner. No price anywhere.
 */
export async function createLoad(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string; now?: string },
): Promise<Result<CreatedLoad, DeliveryError>> {
  await require(appPool, actor, 'deliveries.write');
  const parsed = parseLoadInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    return await inRequest(appPool, actor, (tx) => createLoadInTx(tx, actor, parsed.value, deps));
  } catch (error) {
    return err(deliveryFailure(error));
  }
}

/**
 * The load itself, in the caller's transaction (the caller checked the permission and parsed the input): the plant's
 * `createLoad` and the trip tracking's first step share it, so no second path writes a delivery. `deps.now` is the clock's
 * instant of the loading (the database's now() when absent).
 */
export async function createLoadInTx(
  tx: pg.PoolClient,
  actor: SessionUser,
  v: LoadInput,
  deps: { today: string; now?: string },
): Promise<Result<CreatedLoad, DeliveryError>> {
  const order = await tx.query<{
    concrete_type_id: string;
    code: string;
    volume_l: number;
    zone_id: string | null;
    is_reversed: boolean;
    plant_id: string | null;
  }>(
    `select concrete_type_id, code, volume_l, zone_id, is_reversed, plant_id from sales_order_ops where id = $1 and reverses_id is null`,
    [v.orderId],
  );
  const o = order.rows[0];
  if (!o) return err('NOT_FOUND');
  if (o.is_reversed) return err('ORDER_CANCELLED');
  const truck = await tx.query<{ capacity_l: number; status: string }>(
    `select capacity_l, status from truck where id = $1`,
    [v.truckId],
  );
  const t = truck.rows[0];
  if (!t) return err('NOT_FOUND');
  if (t.status !== 'active') return err('TRUCK_UNAVAILABLE');
  const loaded = await tx.query<{ v: number }>(
    `select coalesce(sum(volume_l), 0)::int as v from delivery where order_id = $1`,
    [v.orderId],
  );
  const left = remainingVolume(o.volume_l, [Number(loaded.rows[0]?.v)]);
  const volumeL = v.volumeL ?? Math.min(left, t.capacity_l);
  // Nothing left and no volume given: ask for a volume. A volume given beyond what is left is allowed (the plant is
  // never blocked): it is warned about here and recorded by the database for the owner to confirm.
  if (volumeL <= 0) return err('OVER_ORDER');
  if (volumeL > t.capacity_l) return err('OVER_CAPACITY');
  const excessL = Math.max(0, volumeL - left);
  const recetteId = await recetteInForce(tx, o.concrete_type_id, deps.today, o.plant_id);
  if (!recetteId) return err('NO_RECETTE');

  const warnings: CreatedLoad['warnings'] = [];
  if (excessL > 0) {
    const tolerance = await opsParameter(tx, 'load_excess_tolerance_bp');
    warnings.push(
      withinTolerance(o.volume_l, loadedNow(loaded.rows[0]?.v, volumeL), tolerance)
        ? 'OVER_ORDER_MINOR'
        : 'OVER_ORDER',
    );
  }
  if (o.zone_id) {
    const zone = await tx.query<{ one_way_min: number }>('select one_way_min from zone where id = $1', [
      o.zone_id,
    ]);
    const oneWay = zone.rows[0]?.one_way_min;
    if (oneWay !== undefined) {
      const [unloading, limit] = [
        await opsParameter(tx, 'unloading_min'),
        await opsParameter(tx, 'concrete_limit_min'),
      ];
      if (tripExceedsLimit(oneWay, unloading, limit)) warnings.push('LONG_TRIP');
    }
  }

  const { id, blNo } = await insertLoadRows(tx, actor, {
    orderId: v.orderId,
    truckId: v.truckId,
    volumeL,
    date: deps.today,
    recetteId,
    loadedAt: deps.now,
  });
  const effects: Effect[] = [
    { kind: 'document', document: 'bl', code: blNo },
    { kind: 'remaining', orderCode: o.code, remainingL: left - volumeL },
    ...(await stockEffects(tx, 'delivery', id)),
  ];
  return ok({ id, blNo, volumeL, warnings, excessL, effects: visibleEffects(effects, actor.role) });
}

/**
 * Writes a load: the delivery row with its BL number and the stock movements of the recette in force, in the caller's
 * transaction. The guards (live order, truck, what is left, recette) are the database's; the caller checks first to give
 * a readable error. Shared by the plant's `createLoad` and the pilot scenario.
 */
export async function insertLoadRows(
  tx: pg.PoolClient,
  actor: { id: string },
  load: {
    orderId: string;
    truckId: string;
    volumeL: number;
    date: string;
    recetteId: string;
    /** The moment of loading; now() when absent. */
    loadedAt?: string;
  },
): Promise<{ id: string; blNo: string }> {
  const id = randomUUID();
  const blNo = await nextDocNumber(tx, 'BL', load.date);
  await tx.query(
    `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, loaded_at, recette_id, created_by)
     values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8, $9)`,
    [
      id,
      blNo,
      load.orderId,
      load.truckId,
      load.volumeL,
      load.date,
      load.loadedAt ?? null,
      load.recetteId,
      actor.id,
    ],
  );
  await writeLoadMovements(tx, actor, {
    id,
    recetteId: load.recetteId,
    volumeL: load.volumeL,
    date: load.date,
  });
  return { id, blNo };
}

/**
 * The stock a load takes out: every line of the recette in force times the volume (domain/consumption.ts, one rounding
 * per line), written in the load's own transaction. A line that rounds to nothing writes nothing.
 */
async function writeLoadMovements(
  tx: pg.PoolClient,
  actor: { id: string },
  load: { id: string; recetteId: string; volumeL: number; date: string },
): Promise<void> {
  const lines = await tx.query<{ component_id: string; qty_per_m3: string }>(
    `select component_id, qty_per_m3::text from recette_line where recette_id = $1 order by component_id`,
    [load.recetteId],
  );
  const taken = consumptionForLoad(
    lines.rows.map((l) => ({ componentId: l.component_id, qtyPerM3: Number(l.qty_per_m3) })),
    load.volumeL,
  ).filter((q) => q.qtyBase !== 0);
  for (const q of taken) {
    await tx.query(
      `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
       values ($1, $2, $3, $4, 'delivery', $5, $6)`,
      [randomUUID(), q.componentId, load.date, -q.qtyBase, load.id, actor.id],
    );
  }
}

export interface CancelledLoad {
  id: string;
  blNo: string;
}

/**
 * Owner or partner cancels a load (AC-OPS-04): a reversing delivery row with its own BL number, and reversing stock
 * movements for every movement of the load. The original rows are untouched; the volume goes back to the order.
 */
export async function cancelLoad(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<CancelledLoad, DeliveryError | 'ALREADY_CANCELLED'>> {
  await require(appPool, actor, 'deliveries.cancel');
  const parsed = parseCancelLoadInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<CancelledLoad, DeliveryError | 'ALREADY_CANCELLED'>> => {
        const original = await tx.query<{
          order_id: string;
          truck_id: string;
          recette_id: string;
          volume_l: number;
          reverses_id: string | null;
          cancelled: boolean;
        }>(
          `select d.order_id, d.truck_id, d.recette_id, d.volume_l, d.reverses_id,
                exists (select 1 from delivery r where r.reverses_id = d.id) as cancelled
           from delivery d where d.id = $1`,
          [v.deliveryId],
        );
        const o = original.rows[0];
        if (!o || o.reverses_id) return err('NOT_FOUND');
        if (o.cancelled) return err('ALREADY_CANCELLED');
        const id = randomUUID();
        const blNo = await nextDocNumber(tx, 'BL', deps.today);
        await tx.query(
          `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, recette_id, reverses_id, reason, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            blNo,
            o.order_id,
            o.truck_id,
            -o.volume_l,
            deps.today,
            o.recette_id,
            v.deliveryId,
            v.reason,
            actor.id,
          ],
        );
        const moved = await tx.query<{ id: string; component_id: string; qty_base: string }>(
          `select id, component_id, qty_base::text from stock_movement where source = 'delivery' and source_id = $1`,
          [v.deliveryId],
        );
        for (const m of moved.rows) {
          await tx.query(
            `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reverses_id, reason, created_by)
           values ($1, $2, $3, $4, 'reversal', $5, $6, $7, $8)`,
            [randomUUID(), m.component_id, deps.today, -Number(m.qty_base), id, m.id, v.reason, actor.id],
          );
        }
        return ok({ id, blNo });
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_CANCELLED');
    return err(deliveryFailure(error));
  }
}

/** Marks a load made outside any rotation as delivered, now (AC-INT-01); a load of a rotation follows its tracking step. */
export async function markDelivered(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { now: Date },
): Promise<Result<{ id: string }, DeliveryError>> {
  await require(appPool, actor, 'deliveries.deliver');
  const parsed = z.object({ deliveryId: z.uuid() }).safeParse(input);
  if (!parsed.success) return err('INVALID');
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into delivery_delivered (id, delivery_id, at, trip_event_id, created_by) values ($1, $2, $3, null, $4)`,
        [id, parsed.data.deliveryId, deps.now.toISOString(), actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_DELIVERED');
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && /follows its rotation/.test(e.message ?? '')) return err('FOLLOWS_ROTATION');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    return err(deliveryFailure(error));
  }
}

export interface BlReturned {
  id: string;
}
export interface FirstReturn {
  byUserId: string;
  on: string;
}

/** Whoever receives the signed BL records its return, once (A11, AC-OPS-10); a second attempt learns who and when. */
export async function recordBlReturn(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<BlReturned, DeliveryError> | { ok: false; error: 'ALREADY_RETURNED'; first: FirstReturn }> {
  await require(appPool, actor, 'deliveries.bl_return');
  const parsed = parseBlReturnInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into delivery_return (id, delivery_id, returned_on, returned_volume_l, created_by) values ($1, $2, $3, $4, $5)`,
        [id, v.deliveryId, v.returnedOn, v.returnedVolumeL, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const first = await inRequest(appPool, actor, (tx) =>
        tx.query<{ by: string; on: string }>(
          `select created_by::text as by, to_char(returned_on, 'YYYY-MM-DD') as on from delivery_return where delivery_id = $1`,
          [v.deliveryId],
        ),
      );
      const row = first.rows[0];
      if (row) return { ok: false, error: 'ALREADY_RETURNED', first: { byUserId: row.by, on: row.on } };
    }
    return err(deliveryFailure(error));
  }
}
