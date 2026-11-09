import { describe, expect, it } from 'vitest';
import {
  correctionAllowed,
  deriveStages,
  nextStage,
  planRecord,
  STAGES,
  type StageRow,
  tapLocal,
} from './trip-stages';

const T = (m: number) => new Date(Date.UTC(2026, 10, 9, 3, m)).toISOString();
const row = (stage: (typeof STAGES)[number], m: number, over: Partial<StageRow> = {}): StageRow => ({
  stage,
  at: T(m),
  source: 'plant',
  implicit: false,
  clientTime: null,
  correctedAt: null,
  loadLinked: false,
  ...over,
});

describe('T9: the seven stages, in order', () => {
  it("are the seven of the rotation, the driver's first tap first", () => {
    expect(STAGES).toEqual([
      'loading_started',
      'loaded',
      'departed',
      'arrived',
      'unloading_started',
      'unloading_finished',
      'back',
    ]);
  });
});

describe('T9: planRecord (forward only, implicit fill, never overwrite)', () => {
  it('a stage already recorded is returned as it is: nothing is inserted', () => {
    expect(planRecord(['loading_started', 'loaded'], 'loaded')).toEqual({ kind: 'existing' });
  });
  it('an earlier stage than the latest recorded is already there too (the fill guarantees it)', () => {
    expect(planRecord(['loading_started', 'loaded', 'departed'], 'loaded')).toEqual({ kind: 'existing' });
  });
  it('the next stage is inserted alone', () => {
    expect(planRecord(['loading_started'], 'loaded')).toEqual({ kind: 'insert', fill: [], target: 'loaded' });
  });
  it('a later stage fills the skipped ones, in order, implicit', () => {
    expect(planRecord(['loading_started'], 'arrived')).toEqual({
      kind: 'insert',
      fill: ['loaded', 'departed'],
      target: 'arrived',
    });
    expect(planRecord([], 'departed')).toEqual({
      kind: 'insert',
      fill: ['loading_started', 'loaded'],
      target: 'departed',
    });
  });
  it('the first stage has nothing to fill', () => {
    expect(planRecord([], 'loading_started')).toEqual({
      kind: 'insert',
      fill: [],
      target: 'loading_started',
    });
  });
  it('an unknown stage is refused', () => {
    expect(planRecord([], 'teleported')).toEqual({ kind: 'invalid' });
  });
});

describe('T9: nextStage', () => {
  it('is the first stage not recorded, null once back', () => {
    expect(nextStage([])).toBe('loading_started');
    expect(nextStage(['loading_started', 'loaded'])).toBe('departed');
    expect(nextStage([...STAGES])).toBeNull();
  });
});

describe('T9: deriveStages (both screens read the same thing)', () => {
  it('lists seven entries; recorded ones carry who (source), when and implicit', () => {
    const view = deriveStages([
      row('loading_started', 0, { source: 'driver' }),
      row('loaded', 21, { source: 'plant', loadLinked: true }),
      row('departed', 30, { source: 'driver' }),
    ]);
    expect(view.stages.map((s) => s.stage)).toEqual([...STAGES]);
    expect(view.stages[1]).toMatchObject({ done: true, source: 'plant', implicit: false, declared: false });
    expect(view.stages[2]).toMatchObject({ done: true, source: 'driver' });
    expect(view.stages[3]).toMatchObject({ done: false, at: null, source: null });
    expect(view.next).toBe('arrived');
    expect(view.last).toBe('departed');
  });

  it('a loaded stage with no plant load is "declared" (by the driver, or implicit); linked, it is not', () => {
    const declared = deriveStages([
      row('loading_started', 0, { source: 'driver' }),
      row('loaded', 5, { source: 'driver' }),
    ]);
    expect(declared.stages[1]).toMatchObject({ done: true, declared: true });
    const implicit = deriveStages([
      row('loading_started', 5, { source: 'driver', implicit: true }),
      row('loaded', 5, { source: 'driver', implicit: true }),
      row('departed', 5, { source: 'driver' }),
    ]);
    expect(implicit.stages[1]).toMatchObject({ implicit: true, declared: true });
    const confirmed = deriveStages([row('loading_started', 0), row('loaded', 5, { loadLinked: true })]);
    expect(confirmed.stages[1]!.declared).toBe(false);
  });

  it('a correction shows its time as the effective one and says so; the original stays available', () => {
    const view = deriveStages([
      row('loading_started', 0),
      row('loaded', 5, { correctedAt: T(3), loadLinked: true }),
    ]);
    expect(view.stages[1]).toMatchObject({ at: T(3), corrected: true, recordedAt: T(5) });
  });

  it('the rows may come in any order', () => {
    const view = deriveStages([row('departed', 30), row('loading_started', 0), row('loaded', 21)]);
    expect(view.last).toBe('departed');
    expect(view.next).toBe('arrived');
  });

  it('a gap in the stored rows (which the database refuses) is shown as it is, not repaired by the screen', () => {
    const view = deriveStages([row('loading_started', 0), row('departed', 30)]);
    expect(view.stages[1]!.done).toBe(false);
    expect(view.next).toBe('loaded');
  });
});

describe('T9: a correction keeps the order of the stages', () => {
  it('is allowed between the previous and the next stage, inclusive', () => {
    expect(correctionAllowed({ previous: T(0), next: T(30), time: T(10) })).toBe(true);
    expect(correctionAllowed({ previous: T(0), next: T(30), time: T(0) })).toBe(true);
    expect(correctionAllowed({ previous: T(0), next: T(30), time: T(30) })).toBe(true);
  });
  it('is refused before the previous or after the next', () => {
    expect(correctionAllowed({ previous: T(5), next: T(30), time: T(4) })).toBe(false);
    expect(correctionAllowed({ previous: T(5), next: T(30), time: T(31) })).toBe(false);
  });
  it('has no bound where there is no neighbour; a time that is not a date is refused', () => {
    expect(correctionAllowed({ previous: null, next: null, time: T(1) })).toBe(true);
    expect(correctionAllowed({ previous: null, next: null, time: 'later' })).toBe(false);
  });
});

describe("T9: the driver's own tap shows at once (tapLocal)", () => {
  const empty = () => deriveStages([]).stages;
  it('marks the tapped stage as his, and the skipped earlier ones as implicit', () => {
    const out = tapLocal(empty(), 'departed', T(30));
    expect(out.filter((s) => s.done).map((s) => [s.stage, s.implicit, s.source])).toEqual([
      ['loading_started', true, 'driver'],
      ['loaded', true, 'driver'],
      ['departed', false, 'driver'],
    ]);
    expect(out[1]).toMatchObject({ declared: true });
  });
  it('never rewrites a stage that is there, and a stage before the latest done one changes nothing', () => {
    const base = deriveStages([
      row('loading_started', 0, { source: 'plant' }),
      row('loaded', 5, { source: 'plant', loadLinked: true }),
    ]).stages;
    expect(tapLocal(base, 'loaded', T(40))).toEqual(base);
    expect(tapLocal(base, 'loading_started', T(40))).toEqual(base);
    const next = tapLocal(base, 'departed', T(40));
    expect(next[0]).toEqual(base[0]);
    expect(next[1]).toEqual(base[1]);
    expect(next[2]).toMatchObject({ done: true, source: 'driver', at: T(40), implicit: false });
  });
});
