// The driver's and the pump operator's steps and emergency options (REQUIREMENTS-V1 §7). Data, not code: the 3 Nov interview
// of the plant and the drivers will change these lists. A leaf with no import, so client components can use it.

/**
 * The seven taps of a rotation, in order (T9): the driver may tap each of them. `loaded` is the load being on the truck, declared by him; the
 * plant's own load (BL, stock) is its own record. A tap that skips stages fills them in as implicit, on the server and on the phone.
 */
export const DRIVER_STEPS = [
  'loading_started',
  'loaded',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;
export type DriverStep = (typeof DRIVER_STEPS)[number];

/** The stages already recorded, by name (the plant's and the driver's alike), with the driver's own report of the loading. */
export interface DriverTripState {
  loadingStartedAt: string | null;
  steps: Partial<Record<string, string>>;
}

/**
 * The tap the screen offers next, or null once the rotation is back: the first stage nobody has recorded, whoever recorded the earlier ones.
 * Nothing blocks the driver (T9): when the plant has not made its own load yet the screen says so, it does not wait for it.
 */
export function nextDriverTap(state: DriverTripState): { step: DriverStep } | null {
  const at = (step: DriverStep) =>
    step === 'loading_started' ? (state.steps[step] ?? state.loadingStartedAt) : state.steps[step];
  const done = (step: DriverStep) => at(step) !== undefined && at(step) !== null;
  const last = DRIVER_STEPS.reduce((acc, step, i) => (done(step) ? i : acc), -1);
  // Before the truck has left, a missing earlier stage is still offered (data from before the shared status may have `loaded` alone); once
  // it has left, only what comes after the latest stage is.
  const from = last >= DRIVER_STEPS.indexOf('departed') ? last + 1 : 0;
  return (
    DRIVER_STEPS.slice(from)
      .map((step) => ({ step }))
      .find((x) => !done(x.step)) ?? null
  );
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
