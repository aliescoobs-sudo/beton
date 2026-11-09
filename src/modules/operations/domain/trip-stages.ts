// T9: the shared status of a rotation, derived from its stage rows. A leaf with no import: both the driver's phone and the plant's board use it.
// The stage rows are the `trip_event` table; nothing here decides who may record (the database does), it only reads and plans.

/** The seven stages of a rotation, in the order they happen. `loading_started` is the first tap; `loaded` is the load being on the truck. */
export const STAGES = [
  'loading_started',
  'loaded',
  'departed',
  'arrived',
  'unloading_started',
  'unloading_finished',
  'back',
] as const;
export type Stage = (typeof STAGES)[number];

/** Who recorded a stage. Derived from the role by the database, never sent by a caller. */
export type StageSource = 'driver' | 'plant' | 'admin';

/** One stored stage, as the database function `trip_stages` returns it (times are ISO instants). */
export interface StageRow {
  stage: Stage;
  /** The server's instant when it was recorded. */
  at: string;
  source: StageSource;
  /** Filled in because a later stage was recorded first. */
  implicit: boolean;
  /** The phone's time of the tap, when the driver was offline. */
  clientTime: string | null;
  /** The time of the latest correction, if any. */
  correctedAt: string | null;
  /** `loaded` only: the plant's own load (BL, stock) exists and is linked to this stage. */
  loadLinked: boolean;
}

export interface StageView {
  stage: Stage;
  done: boolean;
  /** The effective instant (the correction's when there is one); null when not done. */
  at: string | null;
  /** The instant it was first recorded; differs from `at` only after a correction. */
  recordedAt: string | null;
  source: StageSource | null;
  implicit: boolean;
  corrected: boolean;
  /** `loaded` recorded but the plant's own load is not there yet: shown as declared, nothing in stock or billing follows from it. */
  declared: boolean;
}

export interface StatusView {
  stages: StageView[];
  /** The stage a tap records next; null once the rotation is back. */
  next: Stage | null;
  /** The latest stage in order that is done; null before anything. */
  last: Stage | null;
}

export const isStage = (value: unknown): value is Stage => STAGES.includes(value as Stage);

/** The first stage not recorded yet, or null. */
export function nextStage(recorded: readonly string[]): Stage | null {
  return STAGES.find((s) => !recorded.includes(s)) ?? null;
}

export type RecordPlan =
  { kind: 'existing' } | { kind: 'insert'; fill: Stage[]; target: Stage } | { kind: 'invalid' };

/**
 * What recording `target` does: nothing when it (or, by the fill, a later stage) is already there, else the skipped earlier stages are
 * inserted as implicit and the target after them. An existing stage is never rewritten.
 */
export function planRecord(recorded: readonly string[], target: string): RecordPlan {
  if (!isStage(target)) return { kind: 'invalid' };
  if (recorded.includes(target)) return { kind: 'existing' };
  const index = STAGES.indexOf(target);
  // a later stage already recorded means this one was filled in; if it is missing anyway (rows the database would refuse), it is not re-created
  if (STAGES.slice(index + 1).some((s) => recorded.includes(s))) return { kind: 'existing' };
  return { kind: 'insert', fill: STAGES.slice(0, index).filter((s) => !recorded.includes(s)), target };
}

/** The status both screens show, from the stored rows (any order). A gap is shown as it is: the screen repairs nothing. */
export function deriveStages(rows: readonly StageRow[]): StatusView {
  const byStage = new Map(rows.map((r) => [r.stage, r]));
  const stages: StageView[] = STAGES.map((stage) => {
    const r = byStage.get(stage);
    if (!r) {
      return {
        stage,
        done: false,
        at: null,
        recordedAt: null,
        source: null,
        implicit: false,
        corrected: false,
        declared: false,
      };
    }
    return {
      stage,
      done: true,
      at: r.correctedAt ?? r.at,
      recordedAt: r.at,
      source: r.source,
      implicit: r.implicit,
      corrected: r.correctedAt !== null,
      declared: stage === 'loaded' && !r.loadLinked,
    };
  });
  // "next" and "last" follow the order with no gap: the first missing stage is next, and last is the one just before it
  const firstMissing = stages.findIndex((s) => !s.done);
  const next = firstMissing === -1 ? null : STAGES[firstMissing]!;
  const lastDone = [...stages].reverse().find((s) => s.done);
  return { stages, next, last: lastDone ? lastDone.stage : null };
}

/** A correction must keep the order: not before the previous stage's effective time, not after the next one's. */
export function correctionAllowed(input: {
  previous: string | null;
  next: string | null;
  time: string;
}): boolean {
  const t = Date.parse(input.time);
  if (Number.isNaN(t)) return false;
  if (input.previous !== null && t < Date.parse(input.previous)) return false;
  if (input.next !== null && t > Date.parse(input.next)) return false;
  return true;
}

/**
 * The driver's phone shows his own tap at once, before the server answers: the stage he tapped is done by him, and the earlier ones he skipped
 * are marked implicit (the server will do the same). An existing stage is never rewritten.
 */
export function tapLocal(stages: readonly StageView[], target: Stage, at: string): StageView[] {
  const index = STAGES.indexOf(target);
  if (stages.some((s) => s.done && STAGES.indexOf(s.stage) >= index)) return [...stages];
  return stages.map((s) => {
    const i = STAGES.indexOf(s.stage);
    if (s.done || i > index) return s;
    return {
      ...s,
      done: true,
      at,
      recordedAt: at,
      source: 'driver' as const,
      implicit: i < index,
      corrected: false,
      declared: s.stage === 'loaded',
    };
  });
}
