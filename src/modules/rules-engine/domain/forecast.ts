import { addCentimes, centimes, type Centimes, negateCentimes, subCentimes } from '@/lib/money';
import { desc } from './numeric';
import { forecastDates, type Calendar } from './calendar';
import type { CashFlow, Certainty, Direction } from './types';

export interface ForecastInput {
  today: string;
  /** Working days after today (the screen shows 7 or 14). */
  horizonDays: number;
  /** Cleared cash and bank balances today (R9). */
  encaisse: Centimes;
  /** Balance below which a day is a deficit day (parameter `cash_safety_threshold_centimes`). */
  threshold: Centimes;
  flows: readonly CashFlow[];
  calendar: Calendar;
}

/** A flow as it is listed under its day on the chart. */
export interface DayEvent {
  flowId: string;
  direction: Direction;
  amount: Centimes;
  certainty: Certainty;
  code: string;
  partyName: string;
  method: string;
  /** The date the flow really carries (a flow dated on a day off lands on the next working day). */
  onDate: string;
  /** An outgoing post-dated instrument that may be presented early. */
  earlyPresentable: boolean;
}

export interface ForecastDay {
  date: string;
  /** Normal scenario balance at the end of the day. */
  base: Centimes;
  /** Worst scenario balance: outgoing post-dated instruments counted from their issue date. */
  worst: Centimes;
  inflow: Centimes;
  outflow: Centimes;
  events: DayEvent[];
  /** Outgoing flows that the worst scenario brings to this day while the normal one has them later. */
  worstOnlyEvents: DayEvent[];
}

const signed = (f: CashFlow): number => (f.direction === 'in' ? f.amount : negateCentimes(f.amount));

function eventOf(f: CashFlow, onDate: string): DayEvent {
  return {
    flowId: f.id,
    direction: f.direction,
    amount: f.amount,
    certainty: f.certainty,
    code: f.ref.code,
    partyName: f.partyName,
    method: f.method,
    onDate,
    earlyPresentable: f.earlyPresentable,
  };
}

const bySizeThenId = (a: DayEvent, b: DayEvent) =>
  desc(a.amount, b.amount) || a.flowId.localeCompare(b.flowId);

/**
 * The day-by-day balance, today and the next `horizonDays` working days (R9, R11, R17). Same input, same output: flows are
 * bucketed by date, the balance of a day is the opening cash plus every flow dated up to that day, and a flow already late
 * counts on today. Flows beyond the horizon are ignored.
 */
export function forecastCash(input: ForecastInput): ForecastDay[] {
  const dates = forecastDates(input.today, input.horizonDays, input.calendar);
  const bucket = (date: string): number => {
    // The first day whose date is on or after the flow's date; past the last day: not in the horizon.
    for (let i = 0; i < dates.length; i++) if ((dates[i] as string) >= date) return i;
    return -1;
  };

  const base = dates.map(() => 0);
  const worst = dates.map(() => 0);
  const inflow = dates.map(() => 0);
  const outflow = dates.map(() => 0);
  const events: DayEvent[][] = dates.map(() => []);
  const worstOnly: DayEvent[][] = dates.map(() => []);

  for (const f of input.flows) {
    const b = bucket(f.baseDate);
    const w = bucket(f.worstDate);
    if (b >= 0) {
      base[b] = (base[b] as number) + signed(f);
      if (f.direction === 'in') inflow[b] = (inflow[b] as number) + Number(f.amount);
      else outflow[b] = (outflow[b] as number) + Number(f.amount);
      (events[b] as DayEvent[]).push(eventOf(f, f.baseDate));
    }
    if (w >= 0) {
      worst[w] = (worst[w] as number) + signed(f);
      if (w !== b) (worstOnly[w] as DayEvent[]).push(eventOf(f, f.worstDate));
    }
  }

  let runningBase = input.encaisse as number;
  let runningWorst = input.encaisse as number;
  return dates.map((date, i) => {
    runningBase += base[i] as number;
    runningWorst += worst[i] as number;
    return {
      date,
      base: centimes(runningBase),
      worst: centimes(runningWorst),
      inflow: centimes(inflow[i] as number),
      outflow: centimes(outflow[i] as number),
      events: (events[i] as DayEvent[]).sort(bySizeThenId),
      worstOnlyEvents: (worstOnly[i] as DayEvent[]).sort(bySizeThenId),
    };
  });
}

export interface LowestDay {
  date: string;
  balance: Centimes;
}

/** The day with the lowest balance (the earliest on a tie) in a scenario. */
export function lowestDay(days: readonly ForecastDay[], scenario: 'base' | 'worst'): LowestDay | null {
  let best: LowestDay | null = null;
  for (const d of days) {
    const balance = d[scenario];
    if (best === null || balance < best.balance) best = { date: d.date, balance };
  }
  return best;
}

/** The first day a scenario's balance is below the threshold. */
export function firstDeficit(
  days: readonly ForecastDay[],
  scenario: 'base' | 'worst',
  threshold: Centimes,
): ForecastDay | null {
  return days.find((d) => d[scenario] < threshold) ?? null;
}

/** How far below the threshold a balance is (positive), or zero. */
export const shortfallOf = (balance: Centimes, threshold: Centimes): Centimes =>
  balance < threshold ? subCentimes(threshold, balance) : centimes(0);

export const sumFlows = (flows: readonly CashFlow[]): Centimes =>
  flows.reduce((sum, f) => addCentimes(sum, f.amount), centimes(0));
