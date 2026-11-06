import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import {
  buildBoard,
  type BoardTruck,
  ESTIMATE_STAGES,
  type EstimateStage,
  localMidnightMs,
  type StageEstimates,
  type TimingStep,
  type TimingTrip,
} from '../domain/trip-timing';
import { parameterOrDefault } from '@/modules/platform-security';

// The timing of the rotations (T5 phase 2): the board of a day, the driver's own status, the estimates and their overrides, and the
// deterministic statistics of the delays. Row-level security and the database doors decide who sees what; nothing here ranks a driver.

interface TimingRow {
  trip_id: string;
  seq: number;
  order_code: string;
  plant_id: string | null;
  truck_id: string;
  truck_code: string;
  driver_id: string | null;
  driver_name: string | null;
  zone_id: string | null;
  zone_name: string | null;
  one_way_min: number | null;
  load_min: number;
  depart_min: number;
  arrive_min: number;
  unload_end_min: number;
  back_min: number;
  steps: { step: string; at: string }[];
}

const toTrip = (r: TimingRow, dayStartMs: number): TimingTrip => ({
  tripId: r.trip_id,
  seq: r.seq,
  orderCode: r.order_code,
  plantId: r.plant_id,
  truckId: r.truck_id,
  truckCode: r.truck_code,
  driverId: r.driver_id,
  driverName: r.driver_name,
  zoneId: r.zone_id,
  zoneName: r.zone_name,
  plan: {
    loadMin: r.load_min,
    departMin: r.depart_min,
    arriveMin: r.arrive_min,
    unloadEndMin: r.unload_end_min,
    backMin: r.back_min,
  },
  steps: Object.fromEntries(r.steps.map((s) => [s.step, new Date(s.at).toISOString()])) as Partial<
    Record<TimingStep, string>
  >,
  dayStartMs,
});

/** What each stage lasts when nothing better is known: the plan's own parameters and the zone's one-way time. The plan has no waiting. */
export function defaultEstimates(
  params: { loadingMin: number; unloadingMin: number; returnExtraMin: number; defaultOneWayMin: number },
  oneWayMin: number | null,
): StageEstimates {
  const oneWay = oneWayMin ?? params.defaultOneWayMin;
  return {
    loading: params.loadingMin,
    to_site: oneWay,
    waiting: 0,
    unloading: params.unloadingMin,
    return: oneWay + params.returnExtraMin,
    turnaround: 0,
  };
}

export type EstimateSource = 'history' | 'override' | 'default';
export interface EstimateView {
  minutes: number;
  source: EstimateSource;
}

/** The estimates of every stage for a plant and zone: history (median of the last completed rotations, at least 5), else an override, else the defaults. */
async function estimatesFor(
  tx: pg.PoolClient,
  plantId: string | null,
  zoneId: string | null,
  defaults: StageEstimates,
): Promise<Record<EstimateStage, EstimateView>> {
  const out = {} as Record<EstimateStage, EstimateView>;
  for (const stage of ESTIMATE_STAGES) {
    const { rows } = await tx.query<{ minutes: number; source: 'history' | 'override' }>(
      'select minutes, source from public.trip_stage_estimate($1, $2, $3)',
      [plantId, zoneId, stage],
    );
    out[stage] = rows[0]
      ? { minutes: rows[0].minutes, source: rows[0].source }
      : { minutes: defaults[stage], source: 'default' };
  }
  return out;
}

export interface TimingBoard {
  date: string;
  trucks: BoardTruck[];
  /** Each rotation's estimates by "plant|zone" (what the projection used), with where each figure comes from. */
  estimates: Record<string, Record<EstimateStage, EstimateView>>;
}

const keyOf = (plant: string | null, zone: string | null) => `${plant ?? ''}|${zone ?? ''}`;

/**
 * The timing of a day for the rotations the caller may see (the database decides: a driver his own, a plant manager his plant's, owner and
 * app_admin all). `nowMs` is the business clock, passed in: this function reads no clock of its own.
 */
export async function getTimingBoard(
  appPool: pg.Pool,
  actor: SessionUser,
  date: string,
  nowMs: number,
): Promise<TimingBoard> {
  return inRequest(appPool, actor, async (tx) => {
    const dayStartMs = localMidnightMs(date);
    const rows = (await tx.query<TimingRow>('select * from public.trip_timing($1)', [date])).rows;
    const trips = rows.map((r) => toTrip(r, dayStartMs));
    const param = async (key: 'loading_min' | 'unloading_min' | 'return_extra_min' | 'default_one_way_min') =>
      parameterOrDefault(
        key,
        (await tx.query<{ v: unknown }>('select public.timing_parameter($1) as v', [key])).rows[0]?.v,
      );
    const params = {
      loadingMin: await param('loading_min'),
      unloadingMin: await param('unloading_min'),
      returnExtraMin: await param('return_extra_min'),
      defaultOneWayMin: await param('default_one_way_min'),
    };
    const oneWay = new Map(rows.map((r) => [keyOf(r.plant_id, r.zone_id), r.one_way_min]));
    const estimates: TimingBoard['estimates'] = {};
    for (const t of trips) {
      const k = keyOf(t.plantId, t.zoneId);
      if (!estimates[k])
        estimates[k] = await estimatesFor(
          tx,
          t.plantId,
          t.zoneId,
          defaultEstimates(params, oneWay.get(k) ?? null),
        );
    }
    const asMinutes = (t: TimingTrip): StageEstimates => {
      const e = estimates[keyOf(t.plantId, t.zoneId)]!;
      return Object.fromEntries(ESTIMATE_STAGES.map((s) => [s, e[s].minutes])) as StageEstimates;
    };
    return { date, trucks: buildBoard(trips, asMinutes, nowMs), estimates };
  });
}

export type EstimateError = 'INVALID' | 'FORBIDDEN' | 'NOT_FOUND';

/** A plant manager (own plant), the owner or app_admin overrides the default estimate of a stage for a route. Audited. */
export async function setTripEstimate(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { plantId: string; zoneId: string | null; stage: EstimateStage; minutes: number; reason: string },
): Promise<Result<{ id: string }, EstimateError>> {
  await require(appPool, actor, 'dispatch.write');
  if (!(ESTIMATE_STAGES as readonly string[]).includes(input.stage) || !Number.isInteger(input.minutes))
    return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.set_trip_estimate($1, $2, $3, $4, $5) as id', [
        input.plantId,
        input.zoneId,
        input.stage,
        input.minutes,
        input.reason,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '42501') return err('FORBIDDEN');
    if (e.code === '23514') return err('INVALID');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

export interface DelayStats {
  from: string;
  to: string;
  /** Average stage delay in minutes (signed, one decimal) by step, over the taps the caller may read. */
  byStep: { step: string; taps: number; avgStageDelayMin: number | null }[];
  byRoute: { zone: string | null; taps: number; avgCumulativeDelayMin: number | null }[];
  byDriver: { driverCode: string; driverName: string; taps: number; avgCumulativeDelayMin: number | null }[];
  byDay: { day: string; taps: number; avgCumulativeDelayMin: number | null }[];
}

/**
 * The deterministic statistics of the delays between two days: averages by stage, route, driver and day. They are read under the caller's
 * row-level security, so a driver gets his own taps, a plant manager his plant's, the owner and app_admin both plants, anybody else nothing.
 * Facts only: no ranking, no score.
 */
export async function getDelayStats(
  appPool: pg.Pool,
  actor: SessionUser,
  from: string,
  to: string,
): Promise<DelayStats> {
  return inRequest(appPool, actor, async (tx) => {
    const win = [from, to];
    // Only trip_delay is needed (it carries the day and the zone): a driver cannot read the plan or the orders, and sees his own taps here.
    const base = `from trip_delay d left join zone z on z.id = d.zone_id left join driver dr on dr.id = d.driver_id
                  where d.trip_date between $1::date and $2::date`;
    const avg = (col: string) => `round(avg(${col})::numeric, 1)::float`;
    const byStep = await tx.query<{ step: string; taps: number; avg: number | null }>(
      `select d.step, count(*)::int as taps, ${avg('d.stage_delay_min')} as avg ${base} group by d.step order by array_position(array['loading_started','departed','arrived','unloading_started','unloading_finished','back'], d.step)`,
      win,
    );
    const byRoute = await tx.query<{ zone: string | null; taps: number; avg: number | null }>(
      `select z.name as zone, count(*)::int as taps, ${avg('d.cumulative_delay_min')} as avg ${base} group by z.name order by z.name nulls last`,
      win,
    );
    const byDriver = await tx.query<{ code: string; name: string; taps: number; avg: number | null }>(
      `select dr.code, dr.name, count(*)::int as taps, ${avg('d.cumulative_delay_min')} as avg ${base} group by dr.code, dr.name order by dr.code`,
      win,
    );
    const byDay = await tx.query<{ day: string; taps: number; avg: number | null }>(
      `select to_char(d.trip_date, 'YYYY-MM-DD') as day, count(*)::int as taps, ${avg('d.cumulative_delay_min')} as avg ${base} group by d.trip_date order by d.trip_date`,
      win,
    );
    return {
      from,
      to,
      byStep: byStep.rows.map((r) => ({ step: r.step, taps: r.taps, avgStageDelayMin: r.avg })),
      byRoute: byRoute.rows.map((r) => ({ zone: r.zone, taps: r.taps, avgCumulativeDelayMin: r.avg })),
      byDriver: byDriver.rows.map((r) => ({
        driverCode: r.code,
        driverName: r.name,
        taps: r.taps,
        avgCumulativeDelayMin: r.avg,
      })),
      byDay: byDay.rows.map((r) => ({ day: r.day, taps: r.taps, avgCumulativeDelayMin: r.avg })),
    };
  });
}
