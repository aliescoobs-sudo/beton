import { addCentimes, type Centimes } from '@/lib/money';
import { daysBetween } from '@/modules/ledger';
import { addWorkingDays, type Calendar } from './calendar';
import type { CashFlow, InstrumentFact, OverdueReceivable, PlanItemFact } from './types';

export interface FlowParams {
  today: string;
  /** Working days a deposited cheque or LCN takes to clear (parameter `clearing_delay_days`). */
  clearingDelayDays: number;
  calendar: Calendar;
}

const isPaper = (method: string) => method === 'cheque' || method === 'lcn';
const later = (a: string, b: string) => (a > b ? a : b);

/** The two dates of an instrument (SPEC-rules-engine §3.2): base and worst. */
export function instrumentDates(i: InstrumentFact, p: FlowParams): { baseDate: string; worstDate: string } {
  if (i.direction === 'in') {
    // Cash and transfers need no clearing; a cheque or LCN clears after its deposit.
    if (!isPaper(i.method)) {
      const d = later(i.writtenDate ?? i.receivedDate, p.today);
      return { baseDate: d, worstDate: d };
    }
    const deposit =
      i.state === 'deposited'
        ? (i.depositedOn ?? i.receivedDate)
        : later(i.writtenDate ?? i.receivedDate, p.today);
    const d = later(addWorkingDays(deposit, p.clearingDelayDays, p.calendar), p.today);
    return { baseDate: d, worstDate: d };
  }
  // Outgoing: counted on its written date, and in the worst case from the day it was handed over (it may be presented early).
  const written = later(i.writtenDate ?? i.receivedDate, p.today);
  const issued = later(i.receivedDate, p.today);
  return { baseDate: written, worstDate: issued < written ? issued : written };
}

/**
 * Turns the facts into dated flows. An instrument counts by its own date; a plan item counts for what no allocation covers,
 * so a cheque and the item it covers are never added twice. An overdue receivable is not a flow: a late client is not a
 * promise, so it is listed apart and counts only when it is paid (the option "collect"). An overdue payable is owed today.
 */
export function buildFlows(
  instruments: readonly InstrumentFact[],
  items: readonly PlanItemFact[],
  p: FlowParams,
): { flows: CashFlow[]; overdue: OverdueReceivable[] } {
  const flows: CashFlow[] = [];
  const overdue: OverdueReceivable[] = [];

  for (const i of instruments) {
    const { baseDate, worstDate } = instrumentDates(i, p);
    flows.push({
      id: `instrument:${i.id}`,
      direction: i.direction,
      amount: i.amount,
      baseDate,
      worstDate,
      certainty: i.direction === 'in' ? 'probable' : 'committed',
      source: 'instrument',
      method: i.method,
      instrumentState: i.state,
      ref: { type: 'instrument', id: i.id, code: i.label },
      partyId: i.partyId,
      partyName: i.partyName,
      earlyPresentable: i.direction === 'out' && worstDate < baseDate,
    });
  }

  for (const item of items) {
    if (item.remaining <= 0) continue;
    if (item.direction === 'in' && item.dueDate < p.today) {
      overdue.push({
        id: item.id,
        documentId: item.documentId,
        documentCode: item.documentCode,
        partyId: item.partyId,
        partyName: item.partyName,
        dueDate: item.dueDate,
        daysLate: daysBetween(item.dueDate, p.today),
        amount: item.remaining,
      });
      continue;
    }
    const date = item.direction === 'out' ? later(item.dueDate, p.today) : item.dueDate;
    flows.push({
      id: `plan:${item.id}`,
      direction: item.direction,
      amount: item.remaining,
      baseDate: date,
      worstDate: date,
      certainty: item.direction === 'in' ? 'probable' : 'committed',
      source: 'plan',
      method: item.method,
      instrumentState: null,
      ref: { type: item.kind, id: item.documentId, code: item.documentCode },
      partyId: item.partyId,
      partyName: item.partyName,
      earlyPresentable: false,
      ...(item.documentTotal !== undefined ? { orderTotal: item.documentTotal } : {}),
      ...(item.deliveryDate !== undefined ? { deliveryDate: item.deliveryDate } : {}),
    });
  }

  flows.sort((a, b) => a.baseDate.localeCompare(b.baseDate) || a.id.localeCompare(b.id));
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  return { flows, overdue };
}

export const totalOf = (flows: readonly CashFlow[]): Centimes =>
  flows.reduce((sum, f) => addCentimes(sum, f.amount), 0 as Centimes);
