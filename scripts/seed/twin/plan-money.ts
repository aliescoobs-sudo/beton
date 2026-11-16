// T20 item 3: how clients and suppliers pay, pure and deterministic. Every plan item of an order (or purchase) gets a story: paid on time, paid late, partly paid, handed over
// as a cheque or LCN that is still in the portfolio, deposited and not yet cleared, or not paid at all. The delay depends on the client's behaviour, so the balances spread over
// every aging bucket instead of sitting in one.
import type { Rng } from '../../../src/modules/ledger/domain/scenario.ts';
import { addDays, isWorkingDay } from './context.ts';
import type { Behaviour } from './data.ts';

export type Method = 'cash' | 'cheque' | 'lcn' | 'transfer';
export interface PlanItem {
  itemId: string;
  /** Plan methods: cash, advance, installment, cheque, lcn, transfer. */
  method: string;
  due: string;
  amount: number;
  deliveryDate: string;
}
export interface Story {
  itemId: string;
  method: Method;
  amount: number;
  /** The day the paper or the money reaches us (or leaves us, for a supplier). */
  received: string;
  /** Cheque and LCN: the written date (a cheque may be post-dated to the due date) and the due date. */
  written: string | null;
  dueDate: string | null;
  deposit: string | null;
  clear: string | null;
  bounce: string | null;
}

const DELAY: Record<Behaviour, [number, number]> = {
  good: [-2, 3],
  slow: [8, 30],
  late: [25, 70],
  bad: [40, 130],
};
const nextWorkingDay = (iso: string): string => {
  let d = iso;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
};

/** The settlement method of a plan item: what the plan says, with instalments split between cheques and transfers. */
function methodOf(plan: string, rng: Rng): Method {
  if (plan === 'cash' || plan === 'advance') return 'cash';
  if (plan === 'installment') return rng.next() < 0.7 ? 'cheque' : 'transfer';
  return plan as Method;
}

export function planClientPayment(
  item: PlanItem,
  behaviour: Behaviour,
  rng: Rng,
  anchor: string,
): Story | null {
  const method = methodOf(item.method, rng);
  const paper = method === 'cheque' || method === 'lcn';
  const [lo, hi] = DELAY[behaviour];
  const delay = rng.int(lo, hi);
  const partial = (behaviour === 'slow' || behaviour === 'late') && rng.next() < 0.15;
  const amount = partial ? Math.max(100, Math.round((item.amount * rng.int(50, 80)) / 100)) : item.amount;
  // Paper is handed over with the delivery, post-dated to the due date, by clients that pay on the due date; a slow client hands it over late.
  const handedEarly =
    paper && behaviour !== 'bad' && item.deliveryDate <= anchor && rng.next() < 0.8 && delay <= 3;
  const payDate = addDays(item.due, delay);
  const received = handedEarly ? nextWorkingDay(addDays(item.deliveryDate, rng.int(0, 3))) : payDate;
  if (received > anchor) return null; // not yet: the item stays open (not yet due, or overdue)
  if (!paper) {
    return {
      itemId: item.itemId,
      method,
      amount,
      received,
      written: null,
      dueDate: null,
      deposit: null,
      clear: method === 'transfer' ? received : null,
      bounce: null,
    };
  }
  const written = handedEarly && received < item.due ? item.due : received;
  const deposit = nextWorkingDay(addDays(written > item.due ? written : item.due, rng.int(0, 2)));
  const clear = deposit <= anchor ? nextWorkingDay(addDays(deposit, rng.int(2, 4))) : null;
  return {
    itemId: item.itemId,
    method,
    amount,
    received,
    written,
    dueDate: written > item.due ? written : item.due, // never before the written date
    deposit: deposit <= anchor ? deposit : null,
    clear: clear && clear <= anchor ? clear : null,
    bounce: null,
  };
}

/** What we pay a supplier: on or a little after the due date by cheque, LCN or transfer; a part of the debt is not yet paid or not yet due. */
export function planSupplierPayment(item: PlanItem, rng: Rng, anchor: string): Story | null {
  const method: Method = item.method === 'lcn' ? 'lcn' : item.method === 'transfer' ? 'transfer' : 'cheque';
  const late = rng.next() < 0.18; // a few suppliers are paid late: they show in the supplier aging
  const issue = late ? addDays(item.due, rng.int(35, 60)) : addDays(item.due, rng.int(-4, 4));
  // An LCN is drawn at the purchase and falls due on the due date; a cheque is written when it is handed over.
  const received = method === 'lcn' ? nextWorkingDay(item.deliveryDate) : nextWorkingDay(issue);
  if (received > anchor) return null;
  if (late && issue > anchor) return null;
  const dueDate =
    method === 'lcn'
      ? item.due
      : method === 'cheque'
        ? nextWorkingDay(addDays(received, rng.int(0, 5)))
        : null;
  const clearDay =
    method === 'lcn' ? item.due : method === 'cheque' ? addDays(dueDate as string, rng.int(1, 3)) : received;
  return {
    itemId: item.itemId,
    method,
    amount: item.amount,
    received,
    written: method === 'transfer' ? null : received,
    dueDate: method === 'transfer' ? null : dueDate,
    deposit: null,
    clear:
      clearDay <= anchor ? (nextWorkingDay(clearDay) <= anchor ? nextWorkingDay(clearDay) : clearDay) : null,
    bounce: null,
  };
}
