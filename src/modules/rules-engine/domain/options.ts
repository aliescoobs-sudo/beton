import { addCentimes, type Centimes, centimes, mulDivRound, subCentimes, sumCentimes } from '@/lib/money';
import { daysBetween } from '@/modules/ledger';
import { addWorkingDays, type Calendar } from './calendar';
import { forecastCash, type ForecastDay, lowestDay } from './forecast';
import { asc, desc } from './numeric';
import type { CashFlow, OverdueReceivable } from './types';
import { applyChanges, type Change } from './what-if';

export const CASH_OPTION_KINDS = [
  'DEPOSIT-EARLY',
  'DISCOUNT',
  'POSTPONE-PAYABLE',
  'REQUEST-ADVANCE',
  'COLLECT-OVERDUE',
] as const;
export type CashOptionKind = (typeof CASH_OPTION_KINDS)[number];

/** Basis points in 100 %; days in a year for the discount fee. */
const BP_DENOMINATOR = 10_000;
const DAYS_PER_YEAR = 365;
/** Singles kept per kind before pairs are tried (the strongest by amount). */
const MAX_SINGLES_PER_KIND = 4;
/** Options kept on an alert (SPEC §6). */
export const MAX_OPTIONS = 3;

export interface OptionParams {
  today: string;
  calendar: Calendar;
  horizonDays: number;
  encaisse: Centimes;
  threshold: Centimes;
  /** Parameter `clearing_delay_days`. */
  clearingDelayDays: number;
  /** Parameter `postpone_working_days`: how far a supplier payment is pushed. */
  postponeWorkingDays: number;
  /** Parameter `advance_extra_bp`: the extra advance asked, as a share of the order total. */
  advanceExtraBp: number;
  /** Parameter `discount_rate_bp`: yearly bank rate for discounting an LCN. */
  discountRateBp: number;
}

export interface OptionRef {
  /** The kind of option this reference belongs to (a pair mixes kinds). */
  kind: CashOptionKind;
  type: 'instrument' | 'order' | 'purchase';
  id: string;
  code: string;
  partyId: string;
  partyName: string;
  /** The amount the option moves or asks for. */
  amount: Centimes;
  /** The date it moves to, when it moves. */
  to: string | null;
}

/** What "apply" does besides recording the decision: only the early deposit moves anything by itself. */
export type ApplyAction = { type: 'deposit-instruments'; instrumentIds: string[]; date: string } | null;

export interface CashOption {
  id: string;
  kind: CashOptionKind[];
  changes: Change[];
  refs: OptionRef[];
  counterparties: { id: string; name: string }[];
  /** New balance minus old balance on the target day. */
  gain: Centimes;
  /** Share of the shortfall covered, in basis points (10 000 = fully), computed by integer arithmetic. */
  coverageBp: number;
  full: boolean;
  /** Cover beyond the shortfall (full options only), else zero. */
  surplus: Centimes;
  newBalance: Centimes;
  lowestAfter: { date: string; balance: Centimes } | null;
  /** Days that fall below the threshold with the option and did not without it. */
  newDeficitDates: string[];
  /** Days after the target day that are still below the threshold with the option (the deficit moved, not solved). */
  remainingDeficitDates: string[];
  /** The option makes a day fall below the threshold that was above it without the option. */
  createsNewRisk: boolean;
  /** Bank fee, for a discount. */
  cost: Centimes;
  /** An early deposit presents post-dated cheques before their date (D29): flagged. */
  presentsPostDated: boolean;
  apply: ApplyAction;
  /** The base balance of every forecast day with the option (aligned with `OptionsResult.dates`): the what-if forecast. */
  series: Centimes[];
}

export interface InformationalOption {
  id: string;
  kind: 'COLLECT-OVERDUE';
  partyId: string;
  partyName: string;
  /** Overdue and not counted in the forecast: it counts only when paid. */
  potential: Centimes;
  items: { id: string; code: string; dueDate: string; daysLate: number; amount: Centimes }[];
}

export interface OptionsResult {
  targetDate: string;
  shortfall: Centimes;
  balance: Centimes;
  /** The days of the forecast and the base balance of each without any option. */
  dates: string[];
  baselineSeries: Centimes[];
  /** The best options, ranked (SPEC §6), at most MAX_OPTIONS. */
  ranked: CashOption[];
  /** What was considered and not kept, for the "other" list. */
  others: CashOption[];
  informational: InformationalOption[];
  considered: number;
}

interface Candidate {
  id: string;
  kind: CashOptionKind;
  changes: Change[];
  refs: OptionRef[];
  cost: Centimes;
  presentsPostDated: boolean;
  apply: ApplyAction;
  flowIds: string[];
}

const refOf = (f: CashFlow, amount: Centimes, to: string | null, kind: CashOptionKind): OptionRef => ({
  kind,
  type: f.ref.type,
  id: f.ref.id,
  code: f.ref.code,
  partyId: f.partyId,
  partyName: f.partyName,
  amount,
  to,
});

/** The fee of discounting an LCN: amount × yearly rate × days ÷ 365, one rounding, half away from zero. */
export function discountFee(amount: Centimes, rateBp: number, days: number): Centimes {
  return mulDivRound(amount, rateBp * Math.max(0, days), BP_DENOMINATOR * DAYS_PER_YEAR);
}

const byDateAmountId = (a: CashFlow, b: CashFlow) =>
  a.baseDate.localeCompare(b.baseDate) || desc(a.amount, b.amount) || a.id.localeCompare(b.id);

function coverageBp(gain: number, shortfall: number): number {
  if (gain <= 0 || shortfall <= 0) return 0;
  return Math.min(BP_DENOMINATOR, mulDivRound(centimes(gain), BP_DENOMINATOR, shortfall));
}

/**
 * The resolution options for a deficit on `targetDate` (SPEC §6, A16): a fixed catalogue, each option evaluated by re-running
 * the forecast with the virtual change, every pair of options tried too, then ranked: first those that cover the
 * shortfall fully without creating a new deficit (fewest counterparties, then smallest surplus), then the others by
 * coverage. Nothing is written; "collect overdue" is listed apart because it counts only when paid.
 * `baselineChanges` lets a caller put a known cost in first (the emergency purchase of a day conflict).
 */
export function generateCashOptions(
  flows: readonly CashFlow[],
  overdue: readonly OverdueReceivable[],
  targetDate: string,
  p: OptionParams,
  baselineChanges: readonly Change[] = [],
): OptionsResult {
  const baseline = applyChanges(flows, baselineChanges);
  const forecastOf = (list: readonly CashFlow[]): ForecastDay[] =>
    forecastCash({
      today: p.today,
      horizonDays: p.horizonDays,
      encaisse: p.encaisse,
      threshold: p.threshold,
      flows: list,
      calendar: p.calendar,
    });
  const before = forecastOf(baseline);
  const day = before.find((d) => d.date === targetDate);
  const balance = day?.base ?? centimes(0);
  const shortfall = balance < p.threshold ? subCentimes(p.threshold, balance) : centimes(0);
  const informational = collectOptions(overdue);
  const empty: OptionsResult = {
    targetDate,
    shortfall,
    balance,
    dates: before.map((d) => d.date),
    baselineSeries: before.map((d) => d.base),
    ranked: [],
    others: [],
    informational,
    considered: 0,
  };
  if (!day || shortfall <= 0) return empty;

  const earliest = addWorkingDays(p.today, p.clearingDelayDays, p.calendar);
  const candidates: Candidate[] = [];

  // Early deposit of post-dated cheques in hand; an LCN cannot be presented before its date, it is discounted.
  const inHand = baseline
    .filter(
      (f) =>
        f.direction === 'in' &&
        f.source === 'instrument' &&
        f.instrumentState === 'received' &&
        f.baseDate > targetDate,
    )
    .sort(byDateAmountId);
  if (earliest <= targetDate) {
    const take = (list: CashFlow[], net: (f: CashFlow) => Centimes): CashFlow[] => {
      const chosen: CashFlow[] = [];
      let sum = centimes(0);
      for (const f of list) {
        if (sum >= shortfall) break;
        if (net(f) <= 0) continue;
        chosen.push(f);
        sum = addCentimes(sum, net(f));
      }
      return chosen;
    };
    const cheques = take(
      inHand.filter((f) => f.method === 'cheque'),
      (f) => f.amount,
    );
    if (cheques.length > 0) {
      candidates.push({
        id: `DEPOSIT-EARLY:${cheques.map((f) => f.ref.id).join('+')}`,
        kind: 'DEPOSIT-EARLY',
        changes: cheques.map((f) => ({ type: 'move', flowId: f.id, to: earliest })),
        refs: cheques.map((f) => refOf(f, f.amount, earliest, 'DEPOSIT-EARLY')),
        cost: centimes(0),
        presentsPostDated: true,
        apply: { type: 'deposit-instruments', instrumentIds: cheques.map((f) => f.ref.id), date: p.today },
        flowIds: cheques.map((f) => f.id),
      });
    }
    const netOf = (f: CashFlow) =>
      subCentimes(f.amount, discountFee(f.amount, p.discountRateBp, daysBetween(earliest, f.baseDate)));
    const lcns = take(
      inHand.filter((f) => f.method === 'lcn'),
      netOf,
    );
    if (lcns.length > 0) {
      const fees = lcns.map((f) =>
        discountFee(f.amount, p.discountRateBp, daysBetween(earliest, f.baseDate)),
      );
      candidates.push({
        id: `DISCOUNT:${lcns.map((f) => f.ref.id).join('+')}`,
        kind: 'DISCOUNT',
        changes: lcns.map((f) => ({ type: 'replace', flowId: f.id, amount: netOf(f), to: earliest })),
        refs: lcns.map((f) => refOf(f, f.amount, earliest, 'DISCOUNT')),
        cost: sumCentimes(fees),
        presentsPostDated: false,
        apply: null,
        flowIds: lcns.map((f) => f.id),
      });
    }
  }

  // Postpone a supplier payment (purchase items not backed by an issued instrument: only what no allocation covers counts here).
  const postponeTo = addWorkingDays(targetDate, p.postponeWorkingDays, p.calendar);
  baseline
    .filter(
      (f) =>
        f.direction === 'out' &&
        f.source === 'plan' &&
        f.ref.type === 'purchase' &&
        !f.draft &&
        f.baseDate <= targetDate,
    )
    .sort((a, b) => desc(a.amount, b.amount) || a.id.localeCompare(b.id))
    .slice(0, MAX_SINGLES_PER_KIND)
    .forEach((f) =>
      candidates.push({
        id: `POSTPONE-PAYABLE:${f.id}`,
        kind: 'POSTPONE-PAYABLE',
        changes: [{ type: 'move', flowId: f.id, to: postponeTo }],
        refs: [refOf(f, f.amount, postponeTo, 'POSTPONE-PAYABLE')],
        cost: centimes(0),
        presentsPostDated: false,
        apply: null,
        flowIds: [f.id],
      }),
    );

  // Request an advance on an order delivered by the target day: pull part of its later installments forward.
  const orders = new Map<string, CashFlow[]>();
  for (const f of baseline) {
    if (f.direction !== 'in' || f.source !== 'plan' || f.ref.type !== 'order') continue;
    if (!f.deliveryDate || f.orderTotal === undefined) continue;
    if (f.deliveryDate < p.today || f.deliveryDate > targetDate || f.baseDate <= targetDate) continue;
    const list = orders.get(f.ref.id) ?? [];
    list.push(f);
    orders.set(f.ref.id, list);
  }
  [...orders.values()]
    .map((list) => list.sort(byDateAmountId))
    .sort(
      (a, b) =>
        (b[0]?.orderTotal ?? 0) - (a[0]?.orderTotal ?? 0) ||
        (a[0]?.ref.id ?? '').localeCompare(b[0]?.ref.id ?? ''),
    )
    .slice(0, MAX_SINGLES_PER_KIND)
    .forEach((list) => {
      const first = list[0];
      if (!first || first.orderTotal === undefined || !first.deliveryDate) return;
      const available = sumCentimes(list.map((f) => f.amount));
      let left = Math.min(available, mulDivRound(first.orderTotal, p.advanceExtraBp, BP_DENOMINATOR));
      if (left <= 0) return;
      const to = first.deliveryDate > p.today ? first.deliveryDate : p.today;
      const changes: Change[] = [];
      const asked = left;
      for (const f of list) {
        if (left <= 0) break;
        const part = Math.min(left, Number(f.amount));
        changes.push({ type: 'split', flowId: f.id, amount: centimes(part), to });
        left -= part;
      }
      candidates.push({
        id: `REQUEST-ADVANCE:${first.ref.id}`,
        kind: 'REQUEST-ADVANCE',
        changes,
        refs: [refOf(first, centimes(asked), to, 'REQUEST-ADVANCE')],
        cost: centimes(0),
        presentsPostDated: false,
        apply: null,
        flowIds: list.map((f) => f.id),
      });
    });

  const evaluate = (parts: readonly Candidate[]): CashOption => {
    const changes = parts.flatMap((c) => c.changes);
    const after = forecastOf(applyChanges(baseline, changes));
    const newBalance = after.find((d) => d.date === targetDate)?.base ?? balance;
    const gain = subCentimes(newBalance, balance);
    const before2 = new Map(before.map((d) => [d.date, d.base] as const));
    const newDeficitDates = after
      .filter((d) => d.base < p.threshold && (before2.get(d.date) ?? p.threshold) >= p.threshold)
      .map((d) => d.date);
    const remainingDeficitDates = after
      .filter((d) => d.date > targetDate && d.base < p.threshold)
      .map((d) => d.date);
    const lowAfter = lowestDay(after, 'base');
    const cov = coverageBp(gain, shortfall);
    const refs = parts.flatMap((c) => c.refs);
    const counterparties = [
      ...new Map(refs.map((r) => [r.partyId, { id: r.partyId, name: r.partyName }])).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
    const apply = parts.map((c) => c.apply).find((a) => a !== null) ?? null;
    return {
      id: parts
        .map((c) => c.id)
        .sort()
        .join('&'),
      kind: [...new Set(parts.map((c) => c.kind))].sort() as CashOptionKind[],
      changes,
      refs,
      counterparties,
      gain,
      coverageBp: cov,
      full: cov >= BP_DENOMINATOR,
      surplus: gain > shortfall ? subCentimes(gain, shortfall) : centimes(0),
      newBalance,
      lowestAfter: lowAfter ? { date: lowAfter.date, balance: lowAfter.balance } : null,
      newDeficitDates,
      remainingDeficitDates,
      createsNewRisk: newDeficitDates.length > 0,
      cost: sumCentimes(parts.map((c) => c.cost)),
      presentsPostDated: parts.some((c) => c.presentsPostDated),
      apply,
      series: after.map((d) => d.base),
    };
  };

  const singles = candidates.map((c) => ({ candidate: c, option: evaluate([c]) }));
  const options: CashOption[] = singles.filter((s) => s.option.gain > 0).map((s) => s.option);
  // Pairs: never with a single that already covers the shortfall, never touching the same flow.
  const usable = singles.filter((s) => s.option.gain > 0 && !s.option.full);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      if (!a || !b) continue;
      if (a.candidate.flowIds.some((id) => b.candidate.flowIds.includes(id))) continue;
      const pair = evaluate([a.candidate, b.candidate]);
      if (pair.gain > 0) options.push(pair);
    }
  }

  const ranked = rankOptions(options);
  return {
    targetDate,
    shortfall,
    balance,
    dates: before.map((d) => d.date),
    baselineSeries: before.map((d) => d.base),
    ranked: ranked.slice(0, MAX_OPTIONS),
    others: ranked.slice(MAX_OPTIONS),
    informational,
    considered: options.length,
  };
}

/**
 * SPEC §6 ranking, deterministic: complete options that create no new risk and leave no deficit behind come first (fewer counterparties, then the
 * smaller surplus); then everything else by coverage, then fewer counterparties; ties by id.
 */
export function rankOptions(options: readonly CashOption[]): CashOption[] {
  const clean = (o: CashOption) => o.full && !o.createsNewRisk && o.remainingDeficitDates.length === 0;
  return [...options].sort((a, b) => {
    const ca = clean(a);
    const cb = clean(b);
    if (ca !== cb) return ca ? -1 : 1;
    if (ca && cb) {
      return (
        a.counterparties.length - b.counterparties.length ||
        asc(a.surplus, b.surplus) ||
        a.id.localeCompare(b.id)
      );
    }
    return (
      b.coverageBp - a.coverageBp ||
      Number(a.createsNewRisk) - Number(b.createsNewRisk) ||
      a.counterparties.length - b.counterparties.length ||
      a.id.localeCompare(b.id)
    );
  });
}

/** Overdue receivables per client: not counted anywhere until paid, shown as an action to take. */
export function collectOptions(overdue: readonly OverdueReceivable[]): InformationalOption[] {
  const byParty = new Map<string, OverdueReceivable[]>();
  for (const o of overdue) {
    const list = byParty.get(o.partyId) ?? [];
    list.push(o);
    byParty.set(o.partyId, list);
  }
  return [...byParty.entries()]
    .map(([partyId, list]) => ({
      id: `COLLECT-OVERDUE:${partyId}`,
      kind: 'COLLECT-OVERDUE' as const,
      partyId,
      partyName: list[0]?.partyName ?? '',
      potential: sumCentimes(list.map((o) => o.amount)),
      items: list
        .map((o) => ({
          id: o.id,
          code: o.documentCode,
          dueDate: o.dueDate,
          daysLate: o.daysLate,
          amount: o.amount,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => desc(a.potential, b.potential) || a.id.localeCompare(b.id));
}
