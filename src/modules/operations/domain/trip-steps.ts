// The steps of a rotation: a leaf with no import, so a client component can use it without pulling the server modules.
/** The steps of a rotation, in the order they happen (SPEC-operations §7.3). `loaded` is the load itself (it makes the BL). */
export const TRIP_STEPS = [
  'loaded',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;
export type TripStep = (typeof TRIP_STEPS)[number];

/** The moments recorded so far, ISO instants by step. A step not taken is absent. */
export type TripEvents = Partial<Record<TripStep, string>>;

/** The step a tap records next: the first one not yet recorded, or null once the rotation is back. */
export function nextStep(events: TripEvents): TripStep | null {
  return TRIP_STEPS.find((s) => events[s] === undefined) ?? null;
}
