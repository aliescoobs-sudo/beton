import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import {
  alertKey,
  type AlertEventKind,
  type PersistedAlert,
  type PersistedAlertEvent,
  planSync,
  type RuleHit,
  type RuleId,
  SEVERITIES,
  type Severity,
} from '../domain';

interface AlertRow {
  id: string;
  rule_id: RuleId;
  subject_key: string;
  first_detected_on: string;
}
interface EventRow {
  alert_id: string;
  seq: number;
  kind: AlertEventKind;
  severity: Severity | null;
  override_severity: Severity | null;
  reason: string | null;
  at_date: string;
}

/** Every stored alert with its events. Owner and support only (the tables are money data). */
export async function readPersistedAlerts(tx: pg.PoolClient): Promise<PersistedAlert[]> {
  const alerts = await tx.query<AlertRow>(
    `select id, rule_id, subject_key, to_char(first_detected_on, 'YYYY-MM-DD') as first_detected_on from alert`,
  );
  const events = await tx.query<EventRow>(
    `select alert_id, seq, kind, severity, override_severity, reason, to_char(at_date, 'YYYY-MM-DD') as at_date
       from alert_event order by alert_id, seq`,
  );
  const byAlert = new Map<string, PersistedAlertEvent[]>();
  for (const e of events.rows) {
    const list = byAlert.get(e.alert_id) ?? [];
    list.push({
      seq: e.seq,
      kind: e.kind,
      severity: e.severity,
      overrideSeverity: e.override_severity,
      reason: e.reason,
      atDate: e.at_date,
    });
    byAlert.set(e.alert_id, list);
  }
  return alerts.rows.map((a) => ({
    id: a.id,
    ruleId: a.rule_id,
    subjectKey: a.subject_key,
    firstDetectedOn: a.first_detected_on,
    events: byAlert.get(a.id) ?? [],
  }));
}

export async function listPersistedAlerts(appPool: pg.Pool, actor: SessionUser): Promise<PersistedAlert[]> {
  await require(appPool, actor, 'cash.read');
  return inRequest(appPool, actor, readPersistedAlerts);
}

const isRetryable = (error: unknown) => {
  const code = (error as { code?: string }).code;
  return code === '23505' || code === '40001';
};

/**
 * Brings the stored alerts in line with this run (AC-RE-07): new conditions are created and detected, a changed one gets
 * an event, a gone one is resolved, a returning one is reopened; nothing else is written, so running it again writes
 * nothing. Only the owner writes (RLS says the same); the support role reads. A concurrent run that wins the race makes
 * this one stop quietly: the next load plans again from what is stored.
 */
export async function syncAlerts(
  appPool: pg.Pool,
  actor: SessionUser,
  hits: readonly RuleHit[],
  today: string,
): Promise<{ written: number }> {
  if (actor.role !== 'owner') return { written: 0 };
  await require(appPool, actor, 'cash.decide');
  try {
    return await inRequest(appPool, actor, async (tx) => {
      const persisted = await readPersistedAlerts(tx);
      const plan = planSync(persisted, hits);
      const ids = new Map<string, string>();
      const seqs = new Map(persisted.map((a) => [a.id, a.events.length] as const));
      for (const h of plan.creates) {
        const id = randomUUID();
        ids.set(alertKey(h), id);
        seqs.set(id, 0);
        await tx.query(
          `insert into alert (id, rule_id, subject_key, first_detected_on, created_by) values ($1, $2, $3, $4, $5)`,
          [id, h.ruleId, h.subjectKey, today, actor.id],
        );
      }
      for (const e of plan.events) {
        const alertId = e.alertId ?? ids.get(e.key);
        if (!alertId) continue;
        const seq = (seqs.get(alertId) ?? 0) + 1;
        seqs.set(alertId, seq);
        await tx.query(
          `insert into alert_event (id, alert_id, seq, kind, severity, at_date, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), alertId, seq, e.kind, e.severity, today, actor.id],
        );
      }
      return { written: plan.events.length };
    });
  } catch (error) {
    if (isRetryable(error)) return { written: 0 };
    throw error;
  }
}

const reclassifySchema = z.object({
  alertKey: z.string().min(3).max(300),
  severity: z.enum(SEVERITIES),
  reason: z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

export type ReclassifyError = 'INVALID' | 'NOT_FOUND' | 'SAME_SEVERITY' | 'CONFLICT';

/**
 * The owner sets another severity on an alert, with a mandatory reason (R18, AC-RE-08; sensitive action, the route asks
 * for the second factor). It is one more event: the computed severity is kept next to it, and the override is dropped by
 * the fold if the condition later gets worse. `hits` is this moment's run, so the computed severity is the engine's.
 */
export async function reclassifyAlert(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string; hits: readonly RuleHit[] },
): Promise<Result<{ alertKey: string }, ReclassifyError>> {
  await require(appPool, actor, 'alerts.reclassify');
  const parsed = reclassifySchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  const hit = deps.hits.find((h) => alertKey(h) === v.alertKey);
  if (!hit) return err('NOT_FOUND');
  if (hit.severity === v.severity) return err('SAME_SEVERITY');
  await syncAlerts(appPool, actor, deps.hits, deps.today);
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<{ alertKey: string }, ReclassifyError>> => {
        const found = await tx.query<{ id: string; n: number }>(
          `select a.id, (select count(*)::int from alert_event e where e.alert_id = a.id) as n
           from alert a where a.rule_id = $1 and a.subject_key = $2`,
          [hit.ruleId, hit.subjectKey],
        );
        const row = found.rows[0];
        if (!row) return err('NOT_FOUND');
        await tx.query(
          `insert into alert_event (id, alert_id, seq, kind, severity, override_severity, reason, at_date, created_by)
         values ($1, $2, $3, 'reclassified', $4, $5, $6, $7, $8)`,
          [randomUUID(), row.id, row.n + 1, hit.severity, v.severity, v.reason, deps.today, actor.id],
        );
        return ok({ alertKey: v.alertKey });
      },
    );
  } catch (error) {
    if (isRetryable(error)) return err('CONFLICT');
    throw error;
  }
}
