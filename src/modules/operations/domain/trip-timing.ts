import { minuteOfDay } from './trip-times';

// Stage timing of the rotations (T5 phase 2). Pure and deterministic: no clock, no database, no model. A rotation has a planned timeline
// (the plan's minutes from midnight Casablanca); every driver tap is compared with it; the rest of the rotation is PROJECTED from the last
// tap with the stage estimates; and the projected return decides whether the truck's next rotation will start late. All figures are whole
// minutes. This module only informs: nothing here ranks a driver or changes a plan.

export const TIMING_STEPS = [
  'loading_started',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;
export type TimingStep = (typeof TIMING_STEPS)[number];

/** The stage that ends at each step: the time between the previous step and this one. */
export const STAGE_OF_STEP = {
  departed: 'loading',
  arrived: 'to_site',
  unloading_started: 'waiting',
  unloading_finished: 'unloading',
  back: 'return',
} as const satisfies Partial<Record<TimingStep, string>>;
export const ESTIMATE_STAGES = [
  'loading',
  'to_site',
  'waiting',
  'unloading',
  'return',
  'turnaround',
] as const;
export type EstimateStage = (typeof ESTIMATE_STAGES)[number];
export type StageEstimates = Record<EstimateStage, number>;

/** A stage this many minutes over its estimate (or a start this late) is worth a look; below it is noise. */
export const WATCH_TOLERANCE_MIN = 5;

export interface TimingTrip {
  tripId: string;
  seq: number;
  orderCode: string;
  plantId: string | null;
  truckId: string;
  truckCode: string;
  driverId: string | null;
  driverName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  /** The plan's milestones, minutes from midnight of the trip's day (they may pass 1440). */
  plan: { loadMin: number; departMin: number; arriveMin: number; unloadEndMin: number; backMin: number };
  /** The moments tapped, ISO instants by step (the phone's tap time). */
  steps: Partial<Record<TimingStep, string>>;
  /** Midnight (Casablanca) of the trip's day, in ms since the epoch. */
  dayStartMs: number;
}

const MIN = 60_000;

/** Midnight in Casablanca of a YYYY-MM-DD day, as an instant. The offset is read from the time zone data, never assumed. */
export function localMidnightMs(date: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const m = minuteOfDay(new Date(utc).toISOString());
  const offsetMin = m <= 720 ? m : m - 1440;
  return utc - offsetMin * MIN;
}

/** The planned instant of each step. Unloading starts, in the plan, when the truck arrives (a wait on site shows as delay). */
export function plannedMs(trip: TimingTrip): Record<TimingStep, number> {
  const at = (min: number) => trip.dayStartMs + min * MIN;
  return {
    loading_started: at(trip.plan.loadMin),
    departed: at(trip.plan.departMin),
    arrived: at(trip.plan.arriveMin),
    unloading_started: at(trip.plan.arriveMin),
    unloading_finished: at(trip.plan.unloadEndMin),
    back: at(trip.plan.backMin),
  };
}

const idx = (s: TimingStep) => TIMING_STEPS.indexOf(s);
const tapped = (trip: TimingTrip): { step: TimingStep; ms: number }[] =>
  TIMING_STEPS.flatMap((step) => {
    const iso = trip.steps[step];
    return iso === undefined ? [] : [{ step, ms: Date.parse(iso) }];
  });

export interface Projection {
  started: boolean;
  finished: boolean;
  /** The last step tapped (the one with the latest position in the rotation, a skipped step before it is ignored). */
  lastStep: TimingStep | null;
  /** The next step the driver will tap, or null once back. */
  nextStep: TimingStep | null;
  /** Actual instant where tapped, else the projected one (steps before a skipped tap are left out). */
  timeline: Partial<Record<TimingStep, { ms: number; actual: boolean }>>;
  projectedBackMs: number;
  /** Minutes the stage under way has already run past its estimate (0 when not over, or nothing is under way). */
  overUnderwayMin: number;
}

/**
 * The timeline after the last tap: tapped steps keep their real time; each later step is the previous one plus its stage estimate; the
 * very next step cannot be projected into the past (a stage still running is at least as long as it has run). A rotation that has not
 * started is projected as planned. A skipped step leaves a hole: the projection continues from the last step really tapped.
 */
export function projectTrip(trip: TimingTrip, est: StageEstimates, nowMs: number): Projection {
  const done = tapped(trip);
  const planned = plannedMs(trip);
  const timeline: Projection['timeline'] = {};
  if (done.length === 0) {
    for (const s of TIMING_STEPS) timeline[s] = { ms: planned[s], actual: false };
    return {
      started: false,
      finished: false,
      lastStep: null,
      nextStep: 'loading_started',
      timeline,
      projectedBackMs: planned.back,
      overUnderwayMin: 0,
    };
  }
  for (const d of done) timeline[d.step] = { ms: d.ms, actual: true };
  const last = done.reduce((a, b) => (idx(b.step) > idx(a.step) ? b : a));
  let prev = last.ms;
  let overUnderway = 0;
  let nextStep: TimingStep | null = null;
  for (let j = idx(last.step) + 1; j < TIMING_STEPS.length; j++) {
    const step = TIMING_STEPS[j] as Exclude<TimingStep, 'loading_started'>;
    const stage = STAGE_OF_STEP[step];
    let at = prev + est[stage] * MIN;
    if (j === idx(last.step) + 1) {
      nextStep = step;
      overUnderway = Math.max(0, Math.round((nowMs - at) / MIN));
      at = Math.max(at, nowMs);
    }
    timeline[step] = { ms: at, actual: false };
    prev = at;
  }
  return {
    started: true,
    finished: last.step === 'back',
    lastStep: last.step,
    nextStep,
    timeline,
    projectedBackMs: timeline.back?.ms ?? last.ms,
    overUnderwayMin: overUnderway,
  };
}

export type AlertLevel = 'none' | 'watch' | 'critical';
export interface TripAlert {
  level: AlertLevel;
  /** Minutes the next rotation will start late because of this one (0 unless critical). */
  slipMin: number;
  nextTripId: string | null;
  nextOrderCode: string | null;
  /** Why: a stage over its estimate, a start that is late, or nothing. */
  cause: 'next_trip_delayed' | 'stage_over_estimate' | 'late_start' | null;
  /** The size of the stage overrun or the lateness, in minutes. */
  overMin: number;
}

/** Minutes the next rotation starts late: projected return plus the turnaround, past that rotation's planned start. Never negative. */
export function slipMinutes(
  projectedBackMs: number,
  turnaroundMin: number,
  nextPlannedLoadMs: number,
): number {
  return Math.max(0, Math.round((projectedBackMs + turnaroundMin * MIN - nextPlannedLoadMs) / MIN));
}

/**
 * The state of a rotation: `critical` when the next rotation of the same truck (that has not started) will start late, `watch` when a
 * stage ran over its estimate by more than the tolerance (or the start is that late) without touching the next one, else `none`.
 */
export function alertOf(
  trip: TimingTrip,
  next: TimingTrip | null,
  proj: Projection,
  est: StageEstimates,
  nowMs: number,
): TripAlert {
  const none: TripAlert = {
    level: 'none',
    slipMin: 0,
    nextTripId: null,
    nextOrderCode: null,
    cause: null,
    overMin: 0,
  };
  const nextOpen = next !== null && Object.keys(next.steps).length === 0;
  const slip =
    nextOpen && proj.started
      ? slipMinutes(proj.projectedBackMs, est.turnaround, plannedMs(next)['loading_started'])
      : 0;
  if (slip > 0 && next)
    return {
      level: 'critical',
      slipMin: slip,
      nextTripId: next.tripId,
      nextOrderCode: next.orderCode,
      cause: 'next_trip_delayed',
      overMin: slip,
    };
  // a completed stage that ran over its estimate: the last two taps in order
  const done = tapped(trip).sort((a, b) => idx(a.step) - idx(b.step));
  let over = 0;
  if (done.length >= 2) {
    const [a, b] = done.slice(-2) as [{ step: TimingStep; ms: number }, { step: TimingStep; ms: number }];
    if (idx(b.step) === idx(a.step) + 1 && b.step !== 'loading_started')
      over = Math.round((b.ms - a.ms) / MIN) - est[STAGE_OF_STEP[b.step as keyof typeof STAGE_OF_STEP]];
  }
  over = Math.max(over, proj.overUnderwayMin);
  if (proj.started && !proj.finished && over > WATCH_TOLERANCE_MIN)
    return {
      ...none,
      level: 'watch',
      cause: 'stage_over_estimate',
      overMin: over,
      nextTripId: next?.tripId ?? null,
      nextOrderCode: next?.orderCode ?? null,
    };
  if (!proj.started) {
    const late = Math.round((nowMs - plannedMs(trip)['loading_started']) / MIN);
    if (late > WATCH_TOLERANCE_MIN) return { ...none, level: 'watch', cause: 'late_start', overMin: late };
  }
  return none;
}

export type TruckStatus = 'available' | 'loading' | 'en_route' | 'returning';

/** Where a truck is, from its rotation under way (the first of its day that is started and not back). */
export function truckStatus(current: Projection | null): TruckStatus {
  if (!current || !current.started || current.finished) return 'available';
  if (current.lastStep === 'loading_started') return 'loading';
  if (current.lastStep === 'unloading_finished') return 'returning';
  return 'en_route';
}

export interface BoardTrip {
  trip: TimingTrip;
  projection: Projection;
  alert: TripAlert;
  /** Minutes this rotation's last tap is late against the plan (negative: early); null before any tap. */
  cumulativeDelayMin: number | null;
}
export interface BoardTruck {
  truckId: string;
  truckCode: string;
  plantId: string | null;
  status: TruckStatus;
  /** The worst alert among its rotations. */
  alert: TripAlert;
  trips: BoardTrip[];
}

const rank: Record<AlertLevel, number> = { none: 0, watch: 1, critical: 2 };

/** The board of a day: per truck, its rotations in order with projection and alert. `estimates` answers for a rotation's plant and zone. */
export function buildBoard(
  trips: readonly TimingTrip[],
  estimates: (t: TimingTrip) => StageEstimates,
  nowMs: number,
): BoardTruck[] {
  const byTruck = new Map<string, TimingTrip[]>();
  for (const t of trips) byTruck.set(t.truckId, [...(byTruck.get(t.truckId) ?? []), t]);
  const out: BoardTruck[] = [];
  for (const [truckId, list] of byTruck) {
    const sorted = [...list].sort((a, b) => a.plan.loadMin - b.plan.loadMin || a.seq - b.seq);
    const items: BoardTrip[] = sorted.map((trip, i) => {
      const est = estimates(trip);
      const projection = projectTrip(trip, est, nowMs);
      const next = sorted[i + 1] ?? null;
      const last = tapped(trip).sort((a, b) => idx(b.step) - idx(a.step))[0];
      return {
        trip,
        projection,
        alert: alertOf(trip, next, projection, est, nowMs),
        cumulativeDelayMin: last ? Math.round((last.ms - plannedMs(trip)[last.step]) / MIN) : null,
      };
    });
    const current = items.find((x) => x.projection.started && !x.projection.finished)?.projection ?? null;
    const worst = items.map((x) => x.alert).reduce((a, b) => (rank[b.level] > rank[a.level] ? b : a));
    out.push({
      truckId,
      truckCode: sorted[0]!.truckCode,
      plantId: sorted[0]!.plantId,
      status: truckStatus(current),
      alert: worst,
      trips: items,
    });
  }
  return out.sort((a, b) => a.truckCode.localeCompare(b.truckCode, 'en', { numeric: true }));
}
