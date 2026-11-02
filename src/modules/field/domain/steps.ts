// The driver's and the pump operator's steps and emergency options (REQUIREMENTS-V1 §7). Data, not code: the 3 Nov interview
// of the plant and the drivers will change these lists. A leaf with no import, so client components can use it.

/** The six taps of a rotation, in order. `loading_started` is the driver's own report; the others are the rotation's tracking steps. */
export const DRIVER_STEPS = [
  'loading_started',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;
export type DriverStep = (typeof DRIVER_STEPS)[number];

/** The tracking steps already recorded and the driver's own report of the loading, as a rotation shows them. */
export interface DriverTripState {
  loadingStartedAt: string | null;
  /** Tracking steps by name (`loaded` is the plant's). */
  steps: Partial<Record<string, string>>;
}

/**
 * The tap the screen offers next, or null once the rotation is back. `departed` needs the plant's `loaded` (the BL): until it
 * is there the driver waits ('wait_load'), the tap would be refused by the database.
 */
export function nextDriverTap(state: DriverTripState): { step: DriverStep } | { wait: 'wait_load' } | null {
  if (state.loadingStartedAt === null && state.steps['departed'] === undefined) {
    return { step: 'loading_started' };
  }
  if (state.steps['departed'] === undefined) {
    return state.steps['loaded'] === undefined ? { wait: 'wait_load' } : { step: 'departed' };
  }
  for (const step of ['arrived', 'unloading_started', 'unloading_finished', 'back'] as const) {
    if (state.steps[step] === undefined) return { step };
  }
  return null;
}

/** Where the rotation is, for the emergency options (the same names as the database: `start` before anything is tracked). */
export type EmergencyStage =
  'start' | 'loaded' | 'departed' | 'arrived' | 'unloading_started' | 'unloading_finished' | 'back';

export const EMERGENCY_OPTIONS: Record<EmergencyStage, readonly string[]> = {
  start: ['breakdown', 'accident', 'wrong_load'],
  loaded: ['breakdown', 'accident', 'wrong_load'],
  departed: ['breakdown', 'accident', 'heavy_delay', 'client_cancelled', 'site_closed'],
  arrived: ['site_not_ready', 'site_closed', 'client_cancelled', 'breakdown'],
  unloading_started: ['load_not_enough', 'client_stopped', 'site_not_ready', 'quality_refused', 'breakdown'],
  unloading_finished: ['breakdown', 'accident', 'heavy_delay'],
  back: ['breakdown', 'accident', 'heavy_delay'],
};

const STAGES = ['loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'] as const;
/** The stage of a rotation from its tracking steps: the latest one recorded. */
export function emergencyStage(steps: Partial<Record<string, string>>): EmergencyStage {
  let stage: EmergencyStage = 'start';
  for (const s of STAGES) if (steps[s] !== undefined) stage = s;
  return stage;
}

export const INSTRUCTION_KINDS = ['continue', 'extra_load', 'redirect', 'join'] as const;
export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];

export const PUMP_STEPS = ['arrived', 'set_up', 'pumping_started', 'pumping_ended', 'left'] as const;
export type PumpStep = (typeof PUMP_STEPS)[number];
export function nextPumpStep(done: readonly string[]): PumpStep | null {
  return PUMP_STEPS.find((s) => !done.includes(s)) ?? null;
}
