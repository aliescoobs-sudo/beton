import { type Centimes, sumCentimes } from '@/lib/money';
import { desc } from './numeric';
import { firstDeficit, type DayEvent, type ForecastDay, lowestDay, shortfallOf } from './forecast';
import type { Severity } from './types';

/** How many outflows the cause breakdown of a day lists. */
export const MAX_CAUSES = 5;

export interface BlackDay {
  date: string;
  /** Balance of the scenario that breaks the threshold, on that day. */
  balance: Centimes;
  shortfall: Centimes;
  /** Risk when the normal forecast breaks the threshold; urgent when only the worst case does (DECISIONS 63). */
  severity: Extract<Severity, 'risk' | 'urgent'>;
  scenario: 'base' | 'worst';
  /** The largest outflows of that day, biggest first (what the owner must look at first). */
  causes: DayEvent[];
  /** All the outflows of that day. */
  outflowTotal: Centimes;
  /** The lowest balance of the horizon in the normal scenario, whether or not it breaks the threshold. */
  lowest: { date: string; balance: Centimes } | null;
}

/**
 * The black day (R17, DECISIONS 22, 63): the first day the normal forecast is below the safety threshold (risk); when it
 * never is, the first day the worst case is (urgent, "worst case only"); else none. The causes are that day's largest
 * outflows, with the document and the counterparty; in the worst scenario they include the post-dated instruments that may
 * be presented early.
 */
export function detectBlackDay(days: readonly ForecastDay[], threshold: Centimes): BlackDay | null {
  const lowest = lowestDay(days, 'base');
  const baseDay = firstDeficit(days, 'base', threshold);
  const worstDay = baseDay ? null : firstDeficit(days, 'worst', threshold);
  const day = baseDay ?? worstDay;
  if (!day) return null;
  const scenario = baseDay ? 'base' : 'worst';
  const outflows = [
    ...day.events.filter((e) => e.direction === 'out'),
    ...(scenario === 'worst' ? day.worstOnlyEvents : []),
  ].sort((a, b) => desc(a.amount, b.amount) || a.flowId.localeCompare(b.flowId));
  return {
    date: day.date,
    balance: day[scenario],
    shortfall: shortfallOf(day[scenario], threshold),
    severity: scenario === 'base' ? 'risk' : 'urgent',
    scenario,
    causes: outflows.slice(0, MAX_CAUSES),
    outflowTotal: sumCentimes(outflows.map((e) => e.amount)),
    lowest: lowest ? { date: lowest.date, balance: lowest.balance } : null,
  };
}
