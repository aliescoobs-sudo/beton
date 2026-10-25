import { BUSINESS_TIME_ZONE } from '@/modules/clock';

import { nextStep, TRIP_STEPS, type TripEvents, type TripStep } from './trip-steps';

export { nextStep, TRIP_STEPS, type TripEvents, type TripStep };

const minutesBetween = (from: string | undefined, to: string | undefined): number | null =>
  from === undefined || to === undefined ? null : Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

export interface TripTimes {
  /** Time spent waiting on site before unloading starts (arrived → unloading started). */
  waitingOnSiteMin: number | null;
  unloadingMin: number | null;
  /** Departure to back at the plant. */
  roundTripMin: number | null;
  /** The age of the concrete when unloading ends (loaded → unloading finished): R4 as it really happened. */
  concreteAgeMin: number | null;
  /** Actual departure against the planned one, in minutes (positive: late). */
  departDelayMin: number | null;
}

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "08:40" (Casablanca time) of an ISO instant, formatted where the data is read: the browser's tz data may differ from the server's. */
export function clockOf(iso: string): string {
  const m = minuteOfDay(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes from midnight (Casablanca) of an instant: the unit the plan's milestones are in. */
export function minuteOfDay(iso: string): number {
  const parts = PARTS.formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/**
 * Every figure derived from what was recorded (AC-OPS-17). A step that was skipped leaves the figures that need it empty,
 * never zero. Nothing is stored: these are computed again from the events.
 */
export function tripTimes(events: TripEvents, planned: { departMin: number } | null): TripTimes {
  return {
    waitingOnSiteMin: minutesBetween(events.arrived, events.unloading_started),
    unloadingMin: minutesBetween(events.unloading_started, events.unloading_finished),
    roundTripMin: minutesBetween(events.departed, events.back),
    concreteAgeMin: minutesBetween(events.loaded, events.unloading_finished),
    departDelayMin:
      events.departed !== undefined && planned ? minuteOfDay(events.departed) - planned.departMin : null,
  };
}
