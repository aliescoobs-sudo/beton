import { type Centimes, subCentimes } from '@/lib/money';
import { daysBetween, REGULARIZATION_WINDOW_DAYS } from '@/modules/ledger';
import { detectBlackDay } from './black-day';
import type { DayEvent, ForecastDay } from './forecast';
import type { StockRisk } from './stock-risk';
import type { CashFlow, OverdueReceivable, Severity } from './types';
import { severityRank } from './types';

/** The rules catalogue (SPEC-rules-engine §4). Truck capacity and the reconciliation gap belong to modules not built yet. */
export const RULE_CATALOGUE = [
  'CASH-DEFICIT',
  'CASH-DEFICIT-WORST',
  'PAY-DUE',
  'RCV-DUE',
  'RCV-OVERDUE',
  'CHQ-BOUNCED',
  'STOCK-SHORTAGE',
  'STOCK-LOW',
  'LAW6921-RECEIVABLE',
  'LAW6921-PAYABLE',
  'INVOICE-MONTH-END',
  'DAY-CONFLICT',
] as const;
export type RuleId = (typeof RULE_CATALOGUE)[number];

export type ParamValue = string | number | null;

/** What a rule found. Text is composed by the screen from `ruleId` and `params`; the engine never writes sentences. */
export interface RuleHit {
  ruleId: RuleId;
  /** Dedupe key: the same rule and subject is the same alert from one run to the next. */
  subjectKey: string;
  severity: Severity;
  targetDate: string;
  params: Record<string, ParamValue>;
  /** The largest outflows behind a cash alert. */
  causes: DayEvent[];
  /** DAY-CONFLICT only: the keys of the alerts it groups. */
  childKeys: string[];
}

export const alertKey = (h: { ruleId: string; subjectKey: string }): string => `${h.ruleId}:${h.subjectKey}`;

export interface BouncedFact {
  id: string;
  label: string;
  amount: Centimes;
  partyName: string;
  bouncedOn: string;
  /** Last day to regularize (law 71.24). */
  deadline: string;
}

export interface DeadlineFact {
  kind: 'invoice_to_issue' | 'receivable_due' | 'payable_due';
  date: string;
  documentCode: string;
  partyName: string;
  amountCentimes: number | null;
}

export interface RulesInput {
  today: string;
  /** Days ahead that count as "due" (parameter `alert_lead_days`). */
  leadDays: number;
  /** Days ahead of a legal date that raise a reminder (parameter `legal_reminder_days`). */
  legalReminderDays: number;
  /** Window days at which a bounced cheque is reminded (parameter, 20 and 27). */
  bounceReminderDays: readonly number[];
  threshold: Centimes;
  forecast: readonly ForecastDay[];
  flows: readonly CashFlow[];
  overdue: readonly OverdueReceivable[];
  bounced: readonly BouncedFact[];
  stock: StockRisk;
  deadlines: readonly DeadlineFact[];
}

const hit = (
  ruleId: RuleId,
  subjectKey: string,
  severity: Severity,
  targetDate: string,
  params: Record<string, ParamValue>,
  causes: DayEvent[] = [],
): RuleHit => ({ ruleId, subjectKey, severity, targetDate, params, causes, childKeys: [] });

/** One function per rule: pure, each with a positive and a negative test (AC-RE-06). */
export const RULES: Record<Exclude<RuleId, 'DAY-CONFLICT'>, (i: RulesInput) => RuleHit[]> = {
  'CASH-DEFICIT': (i) => {
    const black = detectBlackDay(i.forecast, i.threshold);
    if (!black || black.scenario !== 'base') return [];
    return [
      hit(
        'CASH-DEFICIT',
        black.date,
        'risk',
        black.date,
        {
          balance: black.balance,
          shortfall: black.shortfall,
          lowestDate: black.lowest?.date ?? null,
          lowestBalance: black.lowest?.balance ?? null,
        },
        black.causes,
      ),
    ];
  },

  'CASH-DEFICIT-WORST': (i) => {
    const day = i.forecast.find((d) => d.worst < i.threshold && d.base >= i.threshold);
    if (!day) return [];
    return [
      hit(
        'CASH-DEFICIT-WORST',
        day.date,
        'urgent',
        day.date,
        { balance: day.worst, shortfall: subCentimes(i.threshold, day.worst), baseBalance: day.base },
        day.worstOnlyEvents,
      ),
    ];
  },

  'PAY-DUE': (i) =>
    i.flows
      .filter((f) => f.direction === 'out' && daysBetween(i.today, f.baseDate) <= i.leadDays)
      .map((f) =>
        hit('PAY-DUE', f.id, 'urgent', f.baseDate, {
          code: f.ref.code,
          party: f.partyName,
          amount: f.amount,
          method: f.method,
        }),
      ),

  'RCV-DUE': (i) =>
    i.flows
      .filter(
        (f) => f.direction === 'in' && f.source === 'plan' && daysBetween(i.today, f.baseDate) <= i.leadDays,
      )
      .map((f) =>
        hit('RCV-DUE', f.id, 'probable', f.baseDate, {
          code: f.ref.code,
          party: f.partyName,
          amount: f.amount,
          method: f.method,
        }),
      ),

  'RCV-OVERDUE': (i) =>
    i.overdue.map((o) =>
      hit('RCV-OVERDUE', o.id, 'urgent', o.dueDate, {
        code: o.documentCode,
        party: o.partyName,
        amount: o.amount,
        daysLate: o.daysLate,
      }),
    ),

  'CHQ-BOUNCED': (i) =>
    i.bounced.map((b) => {
      const sinceBounce = daysBetween(b.bouncedOn, i.today);
      const daysLeft = daysBetween(i.today, b.deadline);
      // The latest reminder day reached; past the window it is an escalation (suggest a dispute).
      const reached = i.bounceReminderDays.filter((d) => sinceBounce >= d);
      const reminder = daysLeft < 0 ? 'expired' : reached.length > 0 ? `day${Math.max(...reached)}` : null;
      return hit('CHQ-BOUNCED', b.id, 'risk', b.deadline, {
        label: b.label,
        party: b.partyName,
        amount: b.amount,
        bouncedOn: b.bouncedOn,
        daysLeft,
        windowDays: REGULARIZATION_WINDOW_DAYS,
        reminder,
      });
    }),

  'STOCK-SHORTAGE': (i) =>
    i.stock.components
      .filter((c) => c.firstShortage)
      .map((c) =>
        hit(
          'STOCK-SHORTAGE',
          `${c.componentId}:${c.firstShortage?.date}`,
          'risk',
          c.firstShortage?.date ?? i.today,
          {
            componentId: c.componentId,
            nameFr: c.nameFr,
            nameAr: c.nameAr,
            unit: c.baseUnit,
            missing: c.maxShortage,
            daysUntil: c.daysUntilShortage,
          },
        ),
      ),

  'STOCK-LOW': (i) =>
    i.stock.components
      .filter((c) => c.firstLow)
      .map((c) =>
        hit('STOCK-LOW', `${c.componentId}:${c.firstLow?.date}`, 'urgent', c.firstLow?.date ?? i.today, {
          componentId: c.componentId,
          nameFr: c.nameFr,
          nameAr: c.nameAr,
          unit: c.baseUnit,
          level: c.firstLow?.level ?? null,
          threshold: c.lowThreshold,
        }),
      ),

  'LAW6921-RECEIVABLE': (i) =>
    i.deadlines
      .filter((d) => d.kind === 'receivable_due' && daysBetween(i.today, d.date) <= i.legalReminderDays)
      .map((d) =>
        hit(
          'LAW6921-RECEIVABLE',
          d.documentCode,
          daysBetween(i.today, d.date) < 0 ? 'urgent' : 'probable',
          d.date,
          {
            code: d.documentCode,
            party: d.partyName,
            amount: d.amountCentimes,
            overdue: daysBetween(i.today, d.date) < 0 ? 1 : 0,
          },
        ),
      ),

  'LAW6921-PAYABLE': (i) =>
    i.deadlines
      .filter((d) => d.kind === 'payable_due' && daysBetween(i.today, d.date) <= i.legalReminderDays)
      .map((d) =>
        hit(
          'LAW6921-PAYABLE',
          d.documentCode,
          daysBetween(i.today, d.date) <= i.leadDays ? 'urgent' : 'important',
          d.date,
          {
            code: d.documentCode,
            party: d.partyName,
            amount: d.amountCentimes,
            overdue: daysBetween(i.today, d.date) < 0 ? 1 : 0,
          },
        ),
      ),

  'INVOICE-MONTH-END': (i) => {
    const byDate = new Map<string, number>();
    for (const d of i.deadlines) {
      if (d.kind !== 'invoice_to_issue' || daysBetween(i.today, d.date) > MONTH_END_LEAD_DAYS) continue;
      byDate.set(d.date, (byDate.get(d.date) ?? 0) + 1);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) =>
        hit('INVOICE-MONTH-END', date, 'urgent', date, {
          count,
          overdue: daysBetween(i.today, date) < 0 ? 1 : 0,
        }),
      );
  },
};

/** Days before the end of the month at which invoices still to issue become an alert (SPEC §4). */
export const MONTH_END_LEAD_DAYS = 3;

/** Rules that can make a conflict when they fall on the same date (SPEC §4, "black day"). */
const CONFLICT_FACTORS: readonly RuleId[] = ['CASH-DEFICIT', 'STOCK-SHORTAGE', 'PAY-DUE', 'CHQ-BOUNCED'];

/**
 * The "black day": when at least two different kinds of problem share a date, one parent alert groups them (risk), and
 * the children stay individually actionable.
 */
export function dayConflicts(hits: readonly RuleHit[]): RuleHit[] {
  const byDate = new Map<string, RuleHit[]>();
  for (const h of hits) {
    if (!CONFLICT_FACTORS.includes(h.ruleId)) continue;
    const list = byDate.get(h.targetDate) ?? [];
    list.push(h);
    byDate.set(h.targetDate, list);
  }
  return [...byDate.entries()]
    .filter(([, list]) => new Set(list.map((h) => h.ruleId)).size >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      ruleId: 'DAY-CONFLICT' as const,
      subjectKey: date,
      severity: 'risk' as const,
      targetDate: date,
      params: {
        factors: [...new Set(list.map((h) => h.ruleId))].sort().join(','),
        count: list.length,
      },
      causes: list.find((h) => h.ruleId === 'CASH-DEFICIT')?.causes ?? [],
      childKeys: list.map(alertKey).sort(),
    }));
}

/** Every alert of the run: the rules in catalogue order, then the conflicts that group them. Deterministic. */
export function evaluateRules(input: RulesInput): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const id of RULE_CATALOGUE) {
    if (id === 'DAY-CONFLICT') continue;
    hits.push(
      ...RULES[id](input).sort(
        (a, b) => a.targetDate.localeCompare(b.targetDate) || a.subjectKey.localeCompare(b.subjectKey),
      ),
    );
  }
  hits.push(...dayConflicts(hits));
  return hits;
}

/** The order of the list: conflicts first, then worst severity, then date, then key. */
export function sortAlerts<
  T extends { ruleId: string; severity: Severity; targetDate: string; subjectKey: string },
>(alerts: readonly T[]): T[] {
  return [...alerts].sort(
    (a, b) =>
      Number(b.ruleId === 'DAY-CONFLICT') - Number(a.ruleId === 'DAY-CONFLICT') ||
      severityRank(a.severity) - severityRank(b.severity) ||
      a.targetDate.localeCompare(b.targetDate) ||
      alertKey(a).localeCompare(alertKey(b)),
  );
}
