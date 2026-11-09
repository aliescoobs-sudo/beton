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
  deriveStages,
  nextStage,
  type StageRow,
  type StageSource,
  type StageView,
} from '../domain/trip-stages';
import {
  clockOf,
  TRIP_STEPS,
  type TripEvents,
  type TripStep,
  type TripTimes,
  tripTimes,
} from '../domain/trip-times';
import { createLoadInTx, type CreatedLoad, type DeliveryError, deliveryFailure } from './delivery-service';

// OUT_OF_ORDER and ALREADY_RECORDED are no longer produced (T9: a later stage fills the skipped ones, a second tap is answered with the existing
// record); they stay in the type for the messages of the older screens.
export type TripError =
  'INVALID' | 'NOT_FOUND' | 'OUT_OF_ORDER' | 'ALREADY_RECORDED' | 'CANCELLED' | 'FORBIDDEN' | DeliveryError;

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
  /** T9: the shared status, the same one the driver's phone shows: who recorded each stage and when (an implicit stage is marked). */
  stages: StageView[];
  /** The plant's load of this rotation is marked delivered (by the plant's own stage, or by its confirmation of the driver's). */
  delivered: boolean;
}

/** The live rotations of a day, with their events and the figures derived from them (the plant, owner, partner, support). */
export async function listTrips(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
): Promise<Result<TripView[], 'INVALID'>> {
  await require(appPool, actor, 'trips.read');
  if (!isRealDate(date)) return err('INVALID');
  const { rows, stageRows } = await inRequest(appPool, actor, async (tx) => ({
    stageRows: await readStageRows(tx, date),
    rows: (
      await tx.query<{
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
        delivered: boolean;
        steps: { step: TripStep; at: string; bl_no: string | null }[];
      }>(
        `select p.id, o.code as order_code, o.client_code, t.label as type_label, k.code as truck_code, d.name as driver_name,
              o.site_label, z.name as zone_name, p.volume_l, p.load_min, p.depart_min, p.arrive_min, p.unload_end_min,
              p.back_min,
              exists (select 1 from trip_event l join delivery_delivered dd on dd.delivery_id = l.delivery_id
                       where l.trip_id = p.id and l.step = 'loaded') as delivered,
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
      )
    ).rows,
  }));
  return ok(
    rows.map((r) => {
      const events: TripEvents = {};
      let blNo: string | null = null;
      for (const s of r.steps) {
        events[s.step] = s.at;
        if (s.bl_no) blNo = s.bl_no;
      }
      const status = deriveStages(stageRows.get(r.id) ?? []);
      // the effective time of a stage (a correction's) is what every figure below reads
      for (const st of status.stages) if (st.at) events[st.stage] = st.at;
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
        // the plant's next tap: its own load comes first (it fills the driver's "loading began" in as implicit if he has not tapped it)
        next: nextStage([...status.stages.filter((x) => x.done).map((x) => x.stage), 'loading_started']),
        times: tripTimes(events, { departMin: r.depart_min }),
        stages: status.stages,
        delivered: r.delivered,
      };
    }),
  );
}

/** The stage rows of a day the caller may see, by rotation (the database function scopes them: a plant manager his plant's, a driver his own). */
async function readStageRows(tx: pg.PoolClient, date: string): Promise<Map<string, StageRow[]>> {
  const { rows } = await tx.query<{
    trip_id: string;
    step: TripStep;
    at: string;
    source: StageSource;
    implicit: boolean;
    client_time: string | null;
    corrected_at: string | null;
    load_linked: boolean;
  }>(
    `select trip_id, step,
            to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, source, implicit,
            to_char(client_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as client_time,
            to_char(corrected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as corrected_at, load_linked
       from public.trip_stages($1)`,
    [date],
  );
  const byTrip = new Map<string, StageRow[]>();
  for (const r of rows) {
    const list = byTrip.get(r.trip_id) ?? [];
    list.push({
      stage: r.step,
      at: r.at,
      source: r.source,
      implicit: r.implicit,
      clientTime: r.client_time,
      correctedAt: r.corrected_at,
      loadLinked: r.load_linked,
    });
    byTrip.set(r.trip_id, list);
  }
  return byTrip;
}

const stepSchema = z.object({ tripId: z.uuid(), step: z.enum(TRIP_STEPS) });

export interface RecordedStep {
  step: TripStep;
  /** The load made by the `loaded` step (BL number, warnings, what it changed); null for the other steps. */
  load: CreatedLoad | null;
  effects: Effect[];
  /** False when the stage was already there: the answer is the existing record (who and when), nothing was changed. */
  recorded: boolean;
  /** Who recorded it and when (the record that now stands). */
  by: { source: StageSource; at: string; implicit: boolean };
}

interface StageOut {
  o_stage: TripStep;
  o_recorded: boolean;
  o_at: Date;
  o_source: StageSource;
  o_implicit: boolean;
}

/**
 * One tap on a rotation, by the plant (T9: the same stage log the driver writes). The stage is recorded by `record_trip_stage`: forward only
 * (a later stage fills the skipped ones as implicit), idempotent (a stage already there is answered with its record), authorized by the
 * database (owner, app_admin, the plant manager of the plant). The plant's own load (the BL and the stock) is made here, in the same
 * transaction, when the plant taps `loaded`: it is linked to the stage, or, when the driver already declared the stage, attached to it.
 * A driver's stage never makes a load, and this function never reads the driver's.
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
      // `loaded` is also the plant's load. Take the trip's lock first (the stage writer's own key), so a driver's tap and this one are ordered.
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('trip_event:' || $1::text, 0))`, [
        tripId,
      ]);
      let load: CreatedLoad | null = null;
      let existingLoad: { delivery_id: string | null } | undefined;
      if (step === 'loaded') {
        existingLoad = (
          await tx.query<{ delivery_id: string | null }>(
            `select delivery_id from trip_event where trip_id = $1 and step = 'loaded'`,
            [tripId],
          )
        ).rows[0];
        if (existingLoad?.delivery_id)
          existingLoad = undefined; // the plant's load is already there: the stage is answered as it stands
        else {
          const made = await createLoadInTx(
            tx,
            actor,
            { orderId: t.order_id, truckId: t.truck_id, volumeL: t.volume_l },
            { today: deps.today, now: at },
          );
          if (!made.ok) return err(made.error);
          load = made.value;
        }
      }
      const out = (
        await tx.query<StageOut>('select * from public.record_trip_stage($1, $2, $3, null, null, $4)', [
          tripId,
          step,
          at,
          // a stage that is not there yet takes the load with it; one the driver declared gets it attached below
          load && !existingLoad ? load.id : null,
        ])
      ).rows[0]!;
      if (load && existingLoad) {
        // the driver (or a later stage) declared `loaded` with no load: the plant's own load is linked to that stage, once
        await tx.query('select public.attach_trip_load($1, $2)', [tripId, load.id]);
      }
      return ok({
        step,
        load,
        effects: load?.effects ?? [],
        recorded: out.o_recorded || load !== null,
        by: { source: out.o_source, at: out.o_at.toISOString(), implicit: out.o_implicit },
      });
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '42501') return err('FORBIDDEN');
    if (e.code === '23514' && /not a live rotation/.test(e.message ?? '')) return err('CANCELLED');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    if (isUniqueViolation(error)) return err('INVALID');
    return err(deliveryFailure(error));
  }
}

const correctionSchema = z.object({
  tripId: z.uuid(),
  step: z.enum(TRIP_STEPS),
  /** The corrected instant (ISO). */
  at: z.iso.datetime(),
  reason: z.string(),
});

/**
 * A correction of the time of a recorded stage: a NEW row that supersedes the time (the stage is not touched), with a mandatory reason, by the
 * plant manager of the plant, the owner or app_admin. The database keeps the order of the stages and writes the hash-chained audit event.
 */
export async function correctTripStage(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ at: string }, 'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'OUT_OF_ORDER'>> {
  await require(appPool, actor, 'trips.correct');
  const parsed = correctionSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const { tripId, step, at, reason } = parsed.data;
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.correct_trip_stage($1, $2, $3, $4)', [tripId, step, at, reason.trim()]),
    );
    return ok({ at });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '42501') return err('FORBIDDEN');
    if (e.code === '23514' && /order of the stages/.test(e.message ?? '')) return err('OUT_OF_ORDER');
    if (e.code === '23514' && /not recorded/.test(e.message ?? '')) return err('NOT_FOUND');
    if (e.code === '23514') return err('INVALID');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

/**
 * The plant confirms a delivery the driver declared (the unloading finished): the plant's own load is marked delivered, once. A driver's tap
 * never does it. Needs the plant's load; refused when it is not recorded.
 */
export async function confirmTripDelivered(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ confirmed: boolean }, 'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'NO_LOAD'>> {
  await require(appPool, actor, 'trips.track');
  const parsed = z.object({ tripId: z.uuid() }).safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    const r = await inRequest(appPool, actor, (tx) =>
      tx.query<{ c: boolean }>('select public.confirm_trip_delivered($1) as c', [parsed.data.tripId]),
    );
    return ok({ confirmed: r.rows[0]!.c });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '42501') return err('FORBIDDEN');
    if (e.code === '23514' && /load is not recorded/.test(e.message ?? '')) return err('NO_LOAD');
    if (e.code === '23514') return err('NOT_FOUND');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

/** The shared status of a day's rotations, for the live refresh of the plant's board: the stages only (who, when), scoped by the database. */
export async function getTripStages(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
): Promise<Result<{ date: string; trips: { id: string; stages: StageView[] }[] }, 'INVALID'>> {
  await require(appPool, actor, 'trips.read');
  if (!isRealDate(date)) return err('INVALID');
  const byTrip = await inRequest(appPool, actor, (tx) => readStageRows(tx, date));
  return ok({
    date,
    trips: [...byTrip.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, rows]) => ({ id, stages: deriveStages(rows).stages })),
  });
}
