import { daysBetween } from '@/modules/ledger';
import { alertKey, type ParamValue, type RuleHit, type RuleId, sortAlerts } from './rules';
import type { DayEvent } from './forecast';
import { type Severity, severityRank } from './types';

/** What is stored about an alert: an identity and an append-only list of events (nothing is ever edited). */
export const ALERT_EVENT_KINDS = [
  'detected',
  'resolved',
  'reopened',
  'severity_changed',
  'reclassified',
] as const;
export type AlertEventKind = (typeof ALERT_EVENT_KINDS)[number];

export interface PersistedAlertEvent {
  seq: number;
  kind: AlertEventKind;
  /** The computed severity when the event was written. */
  severity: Severity | null;
  /** `reclassified` only: the severity the owner chose. */
  overrideSeverity: Severity | null;
  reason: string | null;
  atDate: string;
}

export interface PersistedAlert {
  id: string;
  ruleId: RuleId;
  subjectKey: string;
  /** The first day the engine saw it. Never changed: it proves "detected N days ahead" (SPEC §5). */
  firstDetectedOn: string;
  events: PersistedAlertEvent[];
}

export interface AlertState {
  open: boolean;
  /** The last computed severity written. */
  lastSeverity: Severity | null;
  /** The owner's reclassification, while it still holds. */
  override: { severity: Severity; reason: string; computedAt: Severity } | null;
}

/**
 * The state of an alert from its events. A reclassification holds as long as the computed severity is no worse than it was
 * at that moment; when the condition worsens (e.g. the deficit grows) the override is dropped and the alert is back at its
 * computed severity (AC-RE-08). Closed alerts keep their override out of the picture.
 */
export function foldAlert(alert: PersistedAlert, computed: Severity | null = null): AlertState {
  const events = [...alert.events].sort((a, b) => a.seq - b.seq);
  let open = false;
  let lastSeverity: Severity | null = null;
  let reclass: PersistedAlertEvent | null = null;
  for (const e of events) {
    if (e.kind === 'detected' || e.kind === 'reopened') {
      open = true;
      reclass = null;
    } else if (e.kind === 'resolved') open = false;
    if (e.kind === 'reclassified') reclass = e;
    if (e.severity) lastSeverity = e.severity;
  }
  const current = computed ?? lastSeverity;
  const holds =
    reclass !== null &&
    reclass.overrideSeverity !== null &&
    reclass.severity !== null &&
    current !== null &&
    severityRank(current) >= severityRank(reclass.severity);
  return {
    open,
    lastSeverity,
    override:
      holds && reclass?.overrideSeverity
        ? {
            severity: reclass.overrideSeverity,
            reason: reclass.reason ?? '',
            computedAt: reclass.severity as Severity,
          }
        : null,
  };
}

export interface SyncEvent {
  /** Existing alert id, or the key of a hit that is created in the same step. */
  alertId: string | null;
  key: string;
  kind: Extract<AlertEventKind, 'detected' | 'resolved' | 'reopened' | 'severity_changed'>;
  severity: Severity | null;
}
export interface SyncPlan {
  creates: RuleHit[];
  events: SyncEvent[];
}

/**
 * What to write so the stored alerts match this run (AC-RE-07): a new condition is created and detected; a known open one
 * that changed severity gets one event; one that is gone is resolved (kept, with its first detection); one that comes
 * back is reopened; an unchanged one writes nothing. Running it twice on the same input plans nothing the second time.
 */
export function planSync(persisted: readonly PersistedAlert[], hits: readonly RuleHit[]): SyncPlan {
  const byKey = new Map(persisted.map((a) => [alertKey(a), a] as const));
  const seen = new Set<string>();
  const plan: SyncPlan = { creates: [], events: [] };
  for (const h of hits) {
    const key = alertKey(h);
    seen.add(key);
    const existing = byKey.get(key);
    if (!existing) {
      plan.creates.push(h);
      plan.events.push({ alertId: null, key, kind: 'detected', severity: h.severity });
      continue;
    }
    const state = foldAlert(existing);
    if (!state.open) plan.events.push({ alertId: existing.id, key, kind: 'reopened', severity: h.severity });
    else if (state.lastSeverity !== h.severity)
      plan.events.push({ alertId: existing.id, key, kind: 'severity_changed', severity: h.severity });
  }
  for (const a of persisted) {
    const key = alertKey(a);
    if (!seen.has(key) && foldAlert(a).open)
      plan.events.push({ alertId: a.id, key, kind: 'resolved', severity: null });
  }
  return plan;
}

export interface AlertView {
  key: string;
  ruleId: RuleId;
  subjectKey: string;
  /** The severity shown: the owner's reclassification while it holds, else the computed one. */
  severity: Severity;
  computedSeverity: Severity;
  override: { severity: Severity; reason: string } | null;
  targetDate: string;
  params: Record<string, ParamValue>;
  causes: DayEvent[];
  childKeys: string[];
  firstDetectedOn: string;
  /** Days between the first detection and the target date: how early it was seen. */
  daysAhead: number;
}

/** The alerts of a run with what is known of their history, in the order of the list. */
export function viewAlerts(
  hits: readonly RuleHit[],
  persisted: readonly PersistedAlert[],
  today: string,
): AlertView[] {
  const byKey = new Map(persisted.map((a) => [alertKey(a), a] as const));
  const views = hits.map<AlertView>((h) => {
    const key = alertKey(h);
    const stored = byKey.get(key);
    const state = stored ? foldAlert(stored, h.severity) : null;
    const firstDetectedOn = stored?.firstDetectedOn ?? today;
    return {
      key,
      ruleId: h.ruleId,
      subjectKey: h.subjectKey,
      severity: state?.override?.severity ?? h.severity,
      computedSeverity: h.severity,
      override: state?.override ? { severity: state.override.severity, reason: state.override.reason } : null,
      targetDate: h.targetDate,
      params: h.params,
      causes: h.causes,
      childKeys: h.childKeys,
      firstDetectedOn,
      daysAhead: daysBetween(firstDetectedOn, h.targetDate),
    };
  });
  return sortAlerts(views);
}
