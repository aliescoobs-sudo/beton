// The steps of a rotation: a leaf with import of the stage list only, so a client component can use it without pulling the server modules.
import { nextStage, STAGES, type Stage } from './trip-stages';

/** The seven stages of a rotation, in the order they happen (T9). `loaded` is the load being on the truck; the plant's own load (BL, stock) is separate. */
export const TRIP_STEPS = STAGES;
export type TripStep = Stage;

/** The moments recorded so far, ISO instants by step. A step not taken is absent. */
export type TripEvents = Partial<Record<TripStep, string>>;

/** The step a tap records next: the first one not yet recorded, or null once the rotation is back. */
export function nextStep(events: TripEvents): TripStep | null {
  return nextStage(Object.keys(events).filter((k) => events[k as TripStep] !== undefined));
}
