import { integer, scale, subtract, sum } from './money';
import { addMonths, validDate } from './period';
export interface CashFlow {
  id: string;
  commitmentId: string;
  date: string;
  direction: 'in' | 'out';
  amountCentimes: number;
  source: 'schedule' | 'instrument';
  issuedDate?: string;
  method?: string;
}
/** A linked cheque replaces only its covered portion, never the whole installment. */
export function canonicalFlows(flows: readonly CashFlow[]): CashFlow[] {
  const groups = new Map<string, CashFlow[]>();
  const ids = new Set<string>();
  for (const flow of flows) {
    if (ids.has(flow.id)) throw new Error('DUPLICATE_FLOW');
    ids.add(flow.id);
    if (!validDate(flow.date) || integer(flow.amountCentimes) <= 0) throw new Error('INVALID_FLOW');
    groups.set(flow.commitmentId, [...(groups.get(flow.commitmentId) ?? []), flow]);
  }
  return [...groups.values()].flatMap((group) => {
    const schedules = group.filter((f) => f.source === 'schedule'),
      instruments = group.filter((f) => f.source === 'instrument');
    if (schedules.length > 1 || new Set(group.map((f) => f.direction)).size > 1)
      throw new Error('CONFLICTING_COMMITMENT');
    if (!schedules.length) return instruments;
    const s = schedules[0]!,
      remaining = subtract(s.amountCentimes, sum(instruments.map((f) => f.amountCentimes)));
    if (remaining < 0) throw new Error('OVER_COVERED_COMMITMENT');
    return [...instruments, ...(remaining ? [{ ...s, amountCentimes: remaining }] : [])];
  });
}
export function cashForecast(
  openingCentimes: number,
  from: string,
  to: string,
  flows: readonly CashFlow[],
  conservative = false,
) {
  if (!validDate(from) || !validDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 730)
    throw new Error('INVALID_HORIZON');
  let balance = integer(openingCentimes);
  const canonical = canonicalFlows(flows).map((f) => ({
    ...f,
    date: conservative && f.direction === 'out' && f.method === 'cheque' ? (f.issuedDate ?? f.date) : f.date,
  }));
  const days: { date: string; balanceCentimes: number; inCentimes: number; outCentimes: number }[] = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10);
    // Overdue commitments still unpaid are due on the first forecast day.
    const due = canonical.filter((f) => f.date === date || (date === from && f.date < from));
    const ins = sum(due.filter((f) => f.direction === 'in').map((f) => f.amountCentimes)),
      outs = sum(due.filter((f) => f.direction === 'out').map((f) => f.amountCentimes));
    balance = subtract(sum([balance, ins]), outs);
    days.push({ date, balanceCentimes: balance, inCentimes: ins, outCentimes: outs });
  }
  return {
    days,
    minimumCentimes: Math.min(...days.map((d) => d.balanceCentimes)),
    shortageDays: days.filter((d) => d.balanceCentimes < 0),
  };
}
export interface SteelTerms {
  deliveryDate: string;
  cashCentimes: number;
  purchaseCentimes: number;
  chequeCount: number;
}
export function steelFlows(terms: SteelTerms, id = 'steel'): CashFlow[] {
  if (
    !validDate(terms.deliveryDate) ||
    integer(terms.cashCentimes) <= 0 ||
    integer(terms.purchaseCentimes) <= terms.cashCentimes ||
    !Number.isInteger(terms.chequeCount) ||
    terms.chequeCount < 1 ||
    terms.chequeCount > 3
  )
    throw new Error('INVALID_STEEL');
  let assigned = 0;
  return [
    {
      id: id + ':cash',
      commitmentId: id + ':cash',
      date: terms.deliveryDate,
      direction: 'in',
      amountCentimes: terms.cashCentimes,
      source: 'schedule',
    },
    ...Array.from({ length: terms.chequeCount }, (_, i): CashFlow => {
      const amountCentimes =
        i === terms.chequeCount - 1
          ? subtract(terms.purchaseCentimes, assigned)
          : scale(terms.purchaseCentimes, 1, terms.chequeCount);
      assigned = sum([assigned, amountCentimes]);
      return {
        id: `${id}:cheque:${i}`,
        commitmentId: `${id}:cheque:${i}`,
        date: addMonths(terms.deliveryDate, i + 1),
        issuedDate: terms.deliveryDate,
        method: 'cheque',
        direction: 'out',
        amountCentimes,
        source: 'schedule',
      };
    }),
  ];
}
/** Evaluate the entire repayment horizon, including the cheque tail; never recommend a shifted, larger hole. */
export function suggestSteel(
  openingCentimes: number,
  from: string,
  to: string,
  base: CashFlow[],
  deals: SteelTerms[],
  bankCostCentimes: number,
) {
  if (
    !deals.length ||
    deals.length > 12 ||
    integer(bankCostCentimes) < 0 ||
    deals.some((d) => d.deliveryDate < from)
  )
    throw new Error('INVALID_SCENARIO');
  const added = deals.flatMap((d, i) => steelFlows(d, `proposal:${i}`));
  const requiredTo = added.reduce((end, f) => (f.date > end ? f.date : end), to);
  const baseline = cashForecast(openingCentimes, from, requiredTo, base),
    scenario = cashForecast(openingCentimes, from, requiredTo, [...base, ...added]);
  const baselineGap = Math.max(0, -baseline.minimumCentimes),
    scenarioGap = Math.max(0, -scenario.minimumCentimes);
  const costCentimes = sum(deals.map((d) => subtract(d.purchaseCentimes, d.cashCentimes)));
  const initialGapCovered = baseline.shortageDays.every(
    (d) => (scenario.days.find((s) => s.date === d.date)?.balanceCentimes ?? -1) >= 0,
  );
  return {
    initialGapCovered,
    suggested: baselineGap > 0 && initialGapCovered && scenarioGap < baselineGap,
    horizonTo: requiredTo,
    costCentimes,
    bankCostCentimes,
    differenceToBankCentimes: subtract(costCentimes, bankCostCentimes),
    baseline,
    scenario,
    conservative: cashForecast(openingCentimes, from, requiredTo, [...base, ...added], true),
  };
}

/** Cheapest complete proposal first, trying one or more identical deals supplied by the owner. */
export function rankSteelOptions(
  openingCentimes: number,
  from: string,
  to: string,
  base: CashFlow[],
  template: SteelTerms,
  maxDeals: number,
  bankCostPerDealCentimes: number,
) {
  if (!Number.isInteger(maxDeals) || maxDeals < 1 || maxDeals > 12) throw new Error('INVALID_SCENARIO');
  return Array.from({ length: maxDeals }, (_, i) => {
    const count = i + 1;
    return {
      dealCount: count,
      ...suggestSteel(
        openingCentimes,
        from,
        to,
        base,
        Array.from({ length: count }, () => ({ ...template })),
        scale(bankCostPerDealCentimes, count, 1),
      ),
    };
  })
    .filter((o) => o.suggested)
    .sort(
      (a, b) => a.costCentimes - b.costCentimes || b.scenario.minimumCentimes - a.scenario.minimumCentimes,
    );
}
