// The cash forecast of the next 30 / 60 / 90 days (T19c B3, D245). Pure integer-centime arithmetic over dated items; no I/O.
// An item is money that WILL move on its due date: a client cheque or LCN not yet cleared (in), a cheque or LCN we issued not yet cleared (out),
// a loan or leasing instalment (out). Items due before today and still not cleared are "overdue" (they should have moved: the office chases them).
// Horizons are cumulative from today: "30 days" is every item due from today to today + 30 included.

export type ForecastKind = 'client_cheque' | 'issued_cheque' | 'instalment';
export type ForecastSide = 'in' | 'out';

export interface ForecastItem {
  kind: ForecastKind;
  side: ForecastSide;
  /** What the office recognises it by: a cheque number, a reference. */
  label: string;
  party: string | null;
  dueDate: string;
  amountCentimes: number;
}

export const HORIZONS = [30, 60, 90] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface ForecastTotals {
  overdue: number;
  d30: number;
  d60: number;
  d90: number;
}
export interface Forecast {
  today: string;
  /** Per kind of item. */
  byKind: Record<ForecastKind, ForecastTotals>;
  incoming: ForecastTotals;
  outgoing: ForecastTotals;
  /** incoming - outgoing; shown to the roles that read both sides only. */
  net: ForecastTotals;
  /** The items inside the 90 days or overdue, soonest first. */
  items: ForecastItem[];
}

const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;
const none = (): ForecastTotals => ({ overdue: 0, d30: 0, d60: 0, d90: 0 });
const put = (t: ForecastTotals, ahead: number, amount: number) => {
  if (ahead < 0) t.overdue += amount;
  else {
    if (ahead <= 30) t.d30 += amount;
    if (ahead <= 60) t.d60 += amount;
    if (ahead <= 90) t.d90 += amount;
  }
};

export function buildForecast(items: readonly ForecastItem[], today: string): Forecast {
  const byKind: Record<ForecastKind, ForecastTotals> = {
    client_cheque: none(),
    issued_cheque: none(),
    instalment: none(),
  };
  const incoming = none();
  const outgoing = none();
  const kept: ForecastItem[] = [];
  for (const i of items) {
    if (i.amountCentimes <= 0) continue;
    const ahead = day(i.dueDate) - day(today);
    if (ahead > 90) continue;
    kept.push(i);
    put(byKind[i.kind], ahead, i.amountCentimes);
    put(i.side === 'in' ? incoming : outgoing, ahead, i.amountCentimes);
  }
  const net: ForecastTotals = {
    overdue: incoming.overdue - outgoing.overdue,
    d30: incoming.d30 - outgoing.d30,
    d60: incoming.d60 - outgoing.d60,
    d90: incoming.d90 - outgoing.d90,
  };
  kept.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.label.localeCompare(b.label));
  return { today, byKind, incoming, outgoing, net, items: kept };
}
