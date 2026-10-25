import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate, type Effect } from '@/modules/ledger';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import {
  clockOf,
  nextStep,
  TRIP_STEPS,
  type TripEvents,
  type TripStep,
  type TripTimes,
  tripTimes,
} from '../domain/trip-times';
import { createLoadInTx, type CreatedLoad, type DeliveryError, deliveryFailure } from './delivery-service';

export type TripError =
  'INVALID' | 'NOT_FOUND' | 'OUT_OF_ORDER' | 'ALREADY_RECORDED' | 'CANCELLED' | DeliveryError;

/** One rotation of the day with what happened on it so far. Quantities and times only. */
export interface TripView {
  id: string;
  orderCode: string;
  clientCode: string;
  typeLabel: string;
  truckCode: string;
  driverName: string | null;
  siteLabel: string | null;
  zoneName: string | null;
  volumeL: number;
  /** Planned milestones, minutes from midnight. */
  plan: { loadMin: number; departMin: number; arriveMin: number; unloadEndMin: number; backMin: number };
  events: TripEvents;
  /** The time of each recorded step as "08:40", formatted on the server (the browser's time zone data may differ). */
  clock: Partial<Record<TripStep, string>>;
  blNo: string | null;
  next: TripStep | null;
  times: TripTimes;
}

/** The live rotations of a day, with their events and the figures derived from them (the plant, owner, partner, support). */
export async function listTrips(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
): Promise<Result<TripView[], 'INVALID'>> {
  await require(appPool, actor, 'trips.read');
  if (!isRealDate(date)) return err('INVALID');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      order_code: string;
      client_code: string;
      type_label: string;
      truck_code: string;
      driver_name: string | null;
      site_label: string | null;
      zone_name: string | null;
      volume_l: number;
      load_min: number;
      depart_min: number;
      arrive_min: number;
      unload_end_min: number;
      back_min: number;
      steps: { step: TripStep; at: string; bl_no: string | null }[];
    }>(
      `select p.id, o.code as order_code, o.client_code, t.label as type_label, k.code as truck_code, d.name as driver_name,
              o.site_label, z.name as zone_name, p.volume_l, p.load_min, p.depart_min, p.arrive_min, p.unload_end_min,
              p.back_min,
              coalesce((select json_agg(json_build_object('step', e.step, 'at', to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                                                          'bl_no', dl.bl_no) order by e.created_at)
                          from trip_event e left join delivery dl on dl.id = e.delivery_id
                         where e.trip_id = p.id), '[]'::json) as steps
         from trip_plan p
         join sales_order_ops o on o.id = p.order_id
         join concrete_type t on t.id = o.concrete_type_id
         join truck k on k.id = p.truck_id
         left join driver d on d.id = p.driver_id
         left join zone z on z.id = o.zone_id
        where p.trip_date = $1 and not exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id)
        order by p.load_min, o.code, p.seq`,
      [date],
    ),
  );
  return ok(
    rows.map((r) => {
      const events: TripEvents = {};
      let blNo: string | null = null;
      for (const s of r.steps) {
        events[s.step] = s.at;
        if (s.bl_no) blNo = s.bl_no;
      }
      return {
        id: r.id,
        orderCode: r.order_code,
        clientCode: r.client_code,
        typeLabel: r.type_label,
        truckCode: r.truck_code,
        driverName: r.driver_name,
        siteLabel: r.site_label,
        zoneName: r.zone_name,
        volumeL: r.volume_l,
        plan: {
          loadMin: r.load_min,
          departMin: r.depart_min,
          arriveMin: r.arrive_min,
          unloadEndMin: r.unload_end_min,
          backMin: r.back_min,
        },
        events,
        clock: Object.fromEntries(Object.entries(events).map(([k, v]) => [k, clockOf(v)])),
        blNo,
        next: nextStep(events),
        times: tripTimes(events, { departMin: r.depart_min }),
      };
    }),
  );
}

const stepSchema = z.object({ tripId: z.uuid(), step: z.enum(TRIP_STEPS) });

export interface RecordedStep {
  step: TripStep;
  /** The load made by the `loaded` step (BL number, warnings, what it changed); null for the other steps. */
  load: CreatedLoad | null;
  effects: Effect[];
}

/**
 * One tap on a rotation: records the next step with the clock's instant (AC-OPS-16). The first step is the load itself
 * (the same code as the plant's "Chargements": BL, stock down), with the planned volume, in one transaction with the
 * event that links it. A step out of order or already recorded is refused here and by the database; two taps at once
 * record exactly one.
 */
export async function recordTripStep(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string; now: Date },
): Promise<Result<RecordedStep, TripError>> {
  await require(appPool, actor, 'trips.track');
  const parsed = stepSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const { tripId, step } = parsed.data;
  const at = deps.now.toISOString();
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<RecordedStep, TripError>> => {
      const trip = await tx.query<{
        order_id: string;
        truck_id: string;
        volume_l: number;
        cancelled: boolean;
      }>(
        `select p.order_id, p.truck_id, p.volume_l,
                exists (select 1 from trip_plan_cancellation c where c.trip_id = p.id) as cancelled
           from trip_plan p where p.id = $1`,
        [tripId],
      );
      const t = trip.rows[0];
      if (!t) return err('NOT_FOUND');
      if (t.cancelled) return err('CANCELLED');
      const done = await tx.query<{ step: TripStep }>(`select step from trip_event where trip_id = $1`, [
        tripId,
      ]);
      const events: TripEvents = Object.fromEntries(done.rows.map((r) => [r.step, at]));
      if (events[step] !== undefined) return err('ALREADY_RECORDED');
      if (nextStep(events) !== step) return err('OUT_OF_ORDER');

      let load: CreatedLoad | null = null;
      if (step === 'loaded') {
        const made = await createLoadInTx(
          tx,
          actor,
          { orderId: t.order_id, truckId: t.truck_id, volumeL: t.volume_l },
          { today: deps.today, now: at },
        );
        if (!made.ok) return err(made.error);
        load = made.value;
      }
      await tx.query(
        `insert into trip_event (id, trip_id, step, at, delivery_id, created_by) values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), tripId, step, at, load?.id ?? null, actor.id],
      );
      return ok({ step, load, effects: load?.effects ?? [] });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_RECORDED');
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && /previous step|before the previous/.test(e.message ?? ''))
      return err('OUT_OF_ORDER');
    if (e.code === '23514' && /not a live rotation/.test(e.message ?? '')) return err('CANCELLED');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    return err(deliveryFailure(error));
  }
}
