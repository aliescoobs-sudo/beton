import { addDaysIso } from './dates';
import { isEarly } from './instrument-dates';
import type { InstrumentMethod } from './instrument';
import type { PlanMethod } from './plan';
import { daysBetween } from './reversal';

// The pilot scenario (decision 79, fake data only): the plan of what a mid-size plant did in its last three months.
// Pure and seeded: the same inputs give the same plan, so the seed is repeatable. The writer (service/pilot-scenario.ts)
// turns the plan into rows; a test checks that every planned event sequence is a legal lifecycle (domain/instrument.ts).

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32: small, fast, good enough for a demo dataset. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as never,
  };
}

/** A plan item of an order as the writer read it back from the database. */
export interface ScenarioItem {
  itemId: string;
  orderId: string;
  clientId: string;
  method: PlanMethod;
  dueDate: string;
  amountCentimes: number;
  orderDate: string;
}

export type AccountRef = 'caisse' | 'bank1' | 'bank2';

export interface PlannedEvent {
  event: 'deposited' | 'cleared' | 'bounced' | 'regularized' | 'disputed';
  date: string;
  account?: AccountRef;
  reason?: string;
  /** For `regularized`: the key of the instrument plan that covers the bounced one. */
  coveringKey?: string;
  /** For `bounced`: the bank's fee, in centimes. */
  feeCentimes?: number;
}

export interface InstrumentPlan {
  key: string;
  direction: 'in' | 'out';
  method: InstrumentMethod;
  amountCentimes: number;
  clientId?: string;
  supplierId?: string;
  number: string | null;
  bank: string | null;
  writtenDate: string | null;
  receivedDate: string;
  /** The plan item this instrument covers when it is entered (allocation). */
  allocateItemId: string | null;
  /** Events after the first (`received` / `issued`). Cash and transfers are cleared by the writer unless listed. */
  events: PlannedEvent[];
  /** Tags for the tests and the docs: which story this instrument tells. */
  story?:
    | 'bounced-open'
    | 'bounced-regularized'
    | 'bounced-closed'
    | 'bounced-disputed'
    | 'early-deposit'
    | 'tight-day';
}

const BANKS = ['Banque Atlas (fictive)', 'Banque du Rif (fictive)', 'Crédit du Nord (fictif)'] as const;
const PAPER: readonly PlanMethod[] = ['cheque', 'lcn', 'installment'];

let counter = 0;
const nextNumber = (prefix: string) => `${prefix}${String(++counter).padStart(7, '0')}`;
/** The counter restarts for each plan so that the same inputs give the same numbers. */
export const resetNumbers = () => {
  counter = 0;
};

const min = (a: string, b: string) => (a < b ? a : b);
const max = (a: string, b: string) => (a > b ? a : b);

/**
 * How the clients paid. Cash and advances on the due date; transfers the day after; cheques, LCN and instalments are
 * handed over around the order, written for the due date (post-dated), deposited on their date (some before, flagged
 * early) and cleared a day later. A few are left unpaid and overdue. Four scripted stories give every state of a bounce:
 * open window, regularized, window closed, disputed.
 */
export function planClientPayments(
  items: readonly ScenarioItem[],
  today: string,
  rng: Rng,
): InstrumentPlan[] {
  resetNumbers();
  const plans: InstrumentPlan[] = [];
  const stories: NonNullable<InstrumentPlan['story']>[] = [
    'bounced-open',
    'bounced-regularized',
    'bounced-closed',
    'bounced-disputed',
  ];
  const windows: Record<string, [number, number]> = {
    'bounced-open': [8, 14],
    'bounced-regularized': [48, 60],
    'bounced-closed': [40, 55],
    'bounced-disputed': [38, 45],
  };
  const usedClients = new Set<string>();

  for (const item of items) {
    const key = `in-${item.itemId}`;
    const late = daysBetween(item.dueDate, today);
    if (item.method === 'cash' || item.method === 'advance') {
      if (late < 0) continue; // not due yet
      if (late > 3 && rng.int(1, 100) <= 12) continue; // left unpaid, overdue
      plans.push({
        key,
        direction: 'in',
        method: 'cash',
        amountCentimes: item.amountCentimes,
        clientId: item.clientId,
        number: null,
        bank: null,
        writtenDate: null,
        receivedDate: item.dueDate,
        allocateItemId: item.itemId,
        events: [],
      });
      continue;
    }
    if (item.method === 'transfer') {
      if (late < 0) continue;
      if (late > 3 && rng.int(1, 100) <= 10) continue;
      const clearDate = addDaysIso(item.dueDate, 1);
      plans.push({
        key,
        direction: 'in',
        method: 'transfer',
        amountCentimes: item.amountCentimes,
        clientId: item.clientId,
        number: nextNumber('VIR'),
        bank: rng.pick(BANKS),
        writtenDate: null,
        receivedDate: item.dueDate,
        allocateItemId: item.itemId,
        events: clearDate <= today ? [{ event: 'cleared', date: clearDate, account: 'bank1' }] : [],
      });
      continue;
    }
    if (!PAPER.includes(item.method)) continue;
    if (late > 5 && rng.int(1, 100) <= 8) continue; // never paid, overdue
    const method: InstrumentMethod = item.method === 'lcn' ? 'lcn' : 'cheque';
    const receivedDate = min(today, addDaysIso(item.orderDate, rng.int(0, 2)));
    const writtenDate = max(item.dueDate, receivedDate);
    const plan: InstrumentPlan = {
      key,
      direction: 'in',
      method,
      amountCentimes: item.amountCentimes,
      clientId: item.clientId,
      number: nextNumber(method === 'lcn' ? 'LCN' : 'CHQ'),
      bank: rng.pick(BANKS),
      writtenDate,
      receivedDate,
      allocateItemId: item.itemId,
      events: [],
    };
    // Deposit on the written date, sometimes a few days before (presented early, flagged).
    const early = rng.int(1, 100) <= 10 ? rng.int(1, 4) : 0;
    const depositDate = max(receivedDate, addDaysIso(writtenDate, -early));
    if (depositDate <= today) {
      const account: AccountRef = rng.next() < 0.7 ? 'bank1' : 'bank2';
      plan.events.push({ event: 'deposited', date: depositDate, account });
      const clearDate = addDaysIso(depositDate, rng.int(1, 2));
      if (clearDate <= today) plan.events.push({ event: 'cleared', date: clearDate, account });
      if (early > 0 && isEarly(depositDate, writtenDate)) plan.story ??= 'early-deposit';
    }
    plans.push(plan);

    // A scripted bounce story takes the first matching cheque of a client not used yet.
    if (method === 'cheque' && plan.events[0]?.event === 'deposited' && !usedClients.has(item.clientId)) {
      const depositAge = daysBetween(plan.events[0].date, today);
      const index = stories.findIndex((s) => {
        const [from, to] = windows[s] as [number, number];
        return depositAge >= from && depositAge <= to;
      });
      const story = stories[index];
      if (story) {
        stories.splice(index, 1);
        usedClients.add(item.clientId);
        const deposit = plan.events[0].date;
        const bounceDate = addDaysIso(deposit, story === 'bounced-closed' ? 3 : 2);
        plan.story = story;
        plan.events = [
          plan.events[0],
          {
            event: 'bounced',
            date: bounceDate,
            feeCentimes: story === 'bounced-disputed' ? undefined : 2500,
          },
        ];
        if (story === 'bounced-regularized') {
          const coverKey = `${key}-cover`;
          const regDate = addDaysIso(bounceDate, 12);
          plan.events.push({ event: 'regularized', date: regDate, coveringKey: coverKey });
          plans.push({
            key: coverKey,
            direction: 'in',
            method: 'cash',
            amountCentimes: item.amountCentimes,
            clientId: item.clientId,
            number: null,
            bank: null,
            writtenDate: null,
            receivedDate: regDate,
            allocateItemId: item.itemId,
            events: [],
          });
        } else if (story === 'bounced-disputed') {
          plan.events.push({
            event: 'disputed',
            date: addDaysIso(bounceDate, 9),
            reason: 'Le client conteste le montant (fictif)',
          });
        }
      }
    }
  }
  return plans;
}

export interface SupplierRef {
  id: string;
  category: 'cement' | 'aggregates' | 'admixture' | 'transport' | 'fuel' | 'other';
}

/**
 * What the plant paid its suppliers over three months, and the cheques it has issued that the banks have not presented
 * yet. The cement cheque of day +6 is sized so that the day is tight: it exceeds what the accounts hold plus what is
 * expected from the portfolio by `shortfallCentimes`.
 */
export function planSupplierPayments(
  suppliers: readonly SupplierRef[],
  today: string,
  openingDate: string,
  rng: Rng,
  tight: { availableCentimes: number; shortfallCentimes: number },
): InstrumentPlan[] {
  const plans: InstrumentPlan[] = [];
  const by = (category: SupplierRef['category']) => suppliers.filter((s) => s.category === category);
  const round100 = (n: number) => Math.round(n / 10_000) * 10_000;
  const issue = (
    s: SupplierRef,
    method: 'cheque' | 'transfer' | 'cash',
    amount: number,
    receivedDate: string,
    writtenDate: string | null,
    cleared: boolean,
    story?: InstrumentPlan['story'],
  ) => {
    const paper = method === 'cheque';
    const clearDate = paper ? max(receivedDate, writtenDate ?? receivedDate) : addDaysIso(receivedDate, 1);
    plans.push({
      key: `out-${plans.length}`,
      direction: 'out',
      method,
      amountCentimes: amount,
      supplierId: s.id,
      number: paper ? nextNumber('CHQ-E') : method === 'transfer' ? nextNumber('VIR-E') : null,
      bank: method === 'cash' ? null : 'Banque Atlas (fictive)',
      writtenDate: paper ? (writtenDate ?? receivedDate) : null,
      receivedDate,
      allocateItemId: null,
      events:
        cleared && method !== 'cash' && clearDate <= today
          ? [{ event: 'cleared', date: clearDate, account: 'bank1' }]
          : [],
      story,
    });
  };

  // History: monthly cement, fortnightly aggregates, monthly admixture, water and transport, weekly fuel in cash.
  const months = [30, 60, 85];
  for (const age of months) {
    const d = addDaysIso(today, -age);
    for (const s of by('cement')) issue(s, 'cheque', round100(rng.int(48_000_000, 62_000_000)), d, d, true);
    for (const s of by('admixture'))
      issue(s, 'transfer', round100(rng.int(6_000_000, 9_000_000)), addDaysIso(d, 2), null, true);
    for (const s of by('transport'))
      issue(s, 'cheque', round100(rng.int(9_000_000, 14_000_000)), addDaysIso(d, 3), addDaysIso(d, 3), true);
    for (const s of by('other'))
      issue(s, 'transfer', round100(rng.int(1_000_000, 2_000_000)), addDaysIso(d, 4), null, true);
  }
  for (let age = 80; age >= 5; age -= 14) {
    const d = addDaysIso(today, -age);
    for (const s of by('aggregates'))
      issue(s, 'transfer', round100(rng.int(14_000_000, 22_000_000)), d, null, true);
  }
  for (let age = 84; age >= 1; age -= 7) {
    const d = addDaysIso(today, -age);
    for (const s of by('fuel')) issue(s, 'cash', round100(rng.int(300_000, 600_000)), d, null, true);
  }

  // Issued and not presented yet: cheques written for the next two weeks. The cement one makes day +6 tight.
  const cementTight = round100(tight.availableCentimes + tight.shortfallCentimes);
  const upcoming: [SupplierRef['category'], number, number][] = [
    ['aggregates', 2, 18_000_000],
    ['admixture', 4, 7_500_000],
    ['cement', 6, cementTight],
    ['transport', 9, 12_000_000],
    ['fuel', 11, 5_500_000],
    ['other', 13, 1_400_000],
  ];
  for (const [category, inDays, amount] of upcoming) {
    for (const s of by(category).slice(0, 1)) {
      issue(
        s,
        'cheque',
        amount,
        addDaysIso(today, -rng.int(0, 2)),
        addDaysIso(today, inDays),
        false,
        category === 'cement' ? 'tight-day' : undefined,
      );
    }
  }
  void openingDate;
  return plans;
}
