import { describe, expect, it } from 'vitest';
import {
  foldAlert,
  type PersistedAlert,
  type PersistedAlertEvent,
  planSync,
  type SyncPlan,
  viewAlerts,
} from './alert-state';
import { alertKey, type RuleHit } from './rules';
import type { Severity } from './types';

const hit = (subjectKey: string, severity: Severity = 'risk', targetDate = '2026-11-06'): RuleHit => ({
  ruleId: 'CASH-DEFICIT',
  subjectKey,
  severity,
  targetDate,
  params: {},
  causes: [],
  childKeys: [],
});

const ev = (
  seq: number,
  kind: PersistedAlertEvent['kind'],
  over: Partial<PersistedAlertEvent> = {},
): PersistedAlertEvent => ({
  seq,
  kind,
  severity: 'risk',
  overrideSeverity: null,
  reason: null,
  atDate: '2026-11-03',
  ...over,
});

const alert = (events: PersistedAlertEvent[], over: Partial<PersistedAlert> = {}): PersistedAlert => ({
  id: 'a1',
  ruleId: 'CASH-DEFICIT',
  subjectKey: '2026-11-06',
  firstDetectedOn: '2026-11-03',
  events,
  ...over,
});

/** Applies a plan to the stored alerts, as the service does, to prove that a second run plans nothing. */
function apply(persisted: PersistedAlert[], plan: SyncPlan): PersistedAlert[] {
  const next = persisted.map((a) => ({ ...a, events: [...a.events] }));
  for (const h of plan.creates) {
    next.push({
      id: `new:${alertKey(h)}`,
      ruleId: h.ruleId,
      subjectKey: h.subjectKey,
      firstDetectedOn: '2026-11-04',
      events: [],
    });
  }
  for (const e of plan.events) {
    const target = next.find((a) => (e.alertId ? a.id === e.alertId : a.id === `new:${e.key}`));
    if (!target) throw new Error('unknown alert');
    target.events.push(ev(target.events.length + 1, e.kind, { severity: e.severity, atDate: '2026-11-04' }));
  }
  return next;
}

describe('foldAlert', () => {
  it('is open after detection and closed after resolution, and open again when reopened', () => {
    expect(foldAlert(alert([ev(1, 'detected')])).open).toBe(true);
    expect(foldAlert(alert([ev(1, 'detected'), ev(2, 'resolved', { severity: null })])).open).toBe(false);
    expect(
      foldAlert(alert([ev(1, 'detected'), ev(2, 'resolved', { severity: null }), ev(3, 'reopened')])).open,
    ).toBe(true);
  });

  it('reads events in sequence order whatever the order they come in', () => {
    expect(foldAlert(alert([ev(2, 'resolved', { severity: null }), ev(1, 'detected')])).open).toBe(false);
  });

  it('keeps a reclassification while the computed severity is no worse than when it was set (AC-RE-08)', () => {
    const a = alert([
      ev(1, 'detected'),
      ev(2, 'reclassified', { overrideSeverity: 'important', reason: 'résolu mais surveillé' }),
    ]);
    expect(foldAlert(a, 'risk').override).toEqual({
      severity: 'important',
      reason: 'résolu mais surveillé',
      computedAt: 'risk',
    });
    const eased = alert([
      ev(1, 'detected', { severity: 'urgent' }),
      ev(2, 'reclassified', { severity: 'urgent', overrideSeverity: 'probable', reason: 'ok' }),
    ]);
    expect(foldAlert(eased, 'important').override?.severity).toBe('probable');
  });

  it('drops the reclassification when the condition worsens', () => {
    const a = alert([
      ev(1, 'detected', { severity: 'urgent' }),
      ev(2, 'reclassified', { severity: 'urgent', overrideSeverity: 'important', reason: 'ok' }),
    ]);
    expect(foldAlert(a, 'urgent').override).not.toBeNull();
    expect(foldAlert(a, 'risk').override).toBeNull();
  });

  it('forgets a reclassification when the alert is closed and comes back', () => {
    const a = alert([
      ev(1, 'detected'),
      ev(2, 'reclassified', { overrideSeverity: 'important', reason: 'ok' }),
      ev(3, 'resolved', { severity: null }),
      ev(4, 'reopened'),
    ]);
    expect(foldAlert(a, 'risk').override).toBeNull();
  });
});

describe('planSync (AC-RE-07)', () => {
  it('creates and detects a new condition', () => {
    const plan = planSync([], [hit('2026-11-06')]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.events).toEqual([
      { alertId: null, key: 'CASH-DEFICIT:2026-11-06', kind: 'detected', severity: 'risk' },
    ]);
  });

  it('plans nothing when nothing changed, and nothing the second time', () => {
    const hits = [hit('2026-11-06'), hit('2026-11-09', 'urgent')];
    const first = apply([], planSync([], hits));
    expect(planSync(first, hits)).toEqual({ creates: [], events: [] });
  });

  it('writes one event for a changed severity', () => {
    const stored = apply([], planSync([], [hit('2026-11-06')]));
    const plan = planSync(stored, [hit('2026-11-06', 'urgent')]);
    expect(plan.events.map((e) => e.kind)).toEqual(['severity_changed']);
    expect(planSync(apply(stored, plan), [hit('2026-11-06', 'urgent')]).events).toEqual([]);
  });

  it('resolves what is gone, keeps its first detection, and reopens it when it returns', () => {
    const stored = apply([], planSync([], [hit('2026-11-06')]));
    const gone = planSync(stored, []);
    expect(gone.events.map((e) => e.kind)).toEqual(['resolved']);
    const closed = apply(stored, gone);
    expect(planSync(closed, [])).toEqual({ creates: [], events: [] });
    const back = planSync(closed, [hit('2026-11-06')]);
    expect(back.events.map((e) => e.kind)).toEqual(['reopened']);
    expect(back.creates).toEqual([]);
    expect(closed[0]?.firstDetectedOn).toBe('2026-11-04');
  });
});

describe('viewAlerts', () => {
  it('shows when it was first seen and how many days ahead of the target (S1)', () => {
    const [v] = viewAlerts(
      [hit('2026-11-05', 'risk', '2026-11-05')],
      [alert([ev(1, 'detected')], { subjectKey: '2026-11-05', firstDetectedOn: '2026-11-03' })],
      '2026-11-04',
    );
    expect(v).toMatchObject({
      firstDetectedOn: '2026-11-03',
      daysAhead: 2,
      severity: 'risk',
      override: null,
    });
  });

  it('a condition seen for the first time today is dated today', () => {
    const [v] = viewAlerts([hit('2026-11-06', 'risk', '2026-11-06')], [], '2026-11-04');
    expect(v).toMatchObject({ firstDetectedOn: '2026-11-04', daysAhead: 2 });
  });

  it('shows the reclassified severity while it holds, and the computed one when it worsens', () => {
    const stored = alert([
      ev(1, 'detected', { severity: 'urgent' }),
      ev(2, 'reclassified', { severity: 'urgent', overrideSeverity: 'important', reason: 'ok' }),
    ]);
    expect(viewAlerts([hit('2026-11-06', 'urgent')], [stored], '2026-11-04')[0]).toMatchObject({
      severity: 'important',
      computedSeverity: 'urgent',
      override: { reason: 'ok' },
    });
    expect(viewAlerts([hit('2026-11-06', 'risk')], [stored], '2026-11-04')[0]).toMatchObject({
      severity: 'risk',
      override: null,
    });
  });
});
