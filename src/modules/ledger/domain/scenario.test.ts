import { describe, expect, it } from 'vitest';
import { addDaysIso } from './dates';
import { type InstrumentMethod, type InstrumentState, nextState } from './instrument';
import {
  createRng,
  planClientPayments,
  planSupplierPayments,
  type ScenarioItem,
  type SupplierRef,
} from './scenario';

const TODAY = '2026-10-24';

function items(): ScenarioItem[] {
  const rng = createRng(7);
  const out: ScenarioItem[] = [];
  for (let n = 0; n < 160; n++) {
    const orderDate = addDaysIso(TODAY, -rng.int(0, 88));
    const method = rng.pick(['cash', 'advance', 'cheque', 'lcn', 'installment', 'transfer'] as const);
    out.push({
      itemId: `i${n}`,
      orderId: `o${Math.floor(n / 2)}`,
      clientId: `c${n % 25}`,
      method,
      dueDate: addDaysIso(orderDate, method === 'advance' ? 0 : rng.int(0, 90)),
      amountCentimes: rng.int(50_000, 20_000_000),
      orderDate,
    });
  }
  return out;
}

const SUPPLIERS: SupplierRef[] = [
  { id: 's1', category: 'cement' },
  { id: 's2', category: 'aggregates' },
  { id: 's3', category: 'admixture' },
  { id: 's4', category: 'other' },
  { id: 's5', category: 'fuel' },
  { id: 's6', category: 'transport' },
];

const EVENT_STATE = {
  deposited: 'deposited',
  cleared: 'cleared',
  bounced: 'bounced',
  regularized: 'regularized',
  disputed: 'disputed',
} as const;
const EVENT_NAME = {
  deposited: 'deposit',
  cleared: 'clear',
  bounced: 'bounce',
  regularized: 'regularize',
  disputed: 'dispute',
} as const;

describe('the pilot scenario plan', () => {
  it('is the same for the same inputs', () => {
    expect(planClientPayments(items(), TODAY, createRng(1))).toEqual(
      planClientPayments(items(), TODAY, createRng(1)),
    );
  });

  it('walks only legal lifecycles, with dates that never go back and never into the future', () => {
    const plans = [
      ...planClientPayments(items(), TODAY, createRng(1)),
      ...planSupplierPayments(SUPPLIERS, TODAY, '2026-07-26', createRng(2), {
        availableCentimes: 90_000_000,
        shortfallCentimes: 4_000_000,
      }),
    ];
    expect(plans.length).toBeGreaterThan(100);
    for (const p of plans) {
      let state: InstrumentState = p.direction === 'in' ? 'received' : 'issued';
      let last = p.receivedDate;
      expect(p.receivedDate <= TODAY, p.key).toBe(true);
      if (p.method === 'cash') {
        const cleared = nextState(p.direction, p.method as InstrumentMethod, state, 'clear');
        expect(cleared.ok, p.key).toBe(true);
      }
      for (const e of p.events) {
        const next = nextState(p.direction, p.method, state, EVENT_NAME[e.event]);
        expect(next.ok, `${p.key} ${state} -> ${e.event}`).toBe(true);
        expect(e.date >= last, `${p.key} ${e.event} date`).toBe(true);
        expect(e.date <= TODAY, `${p.key} ${e.event} not in the future`).toBe(true);
        last = e.date;
        state = EVENT_STATE[e.event];
      }
    }
  });

  it('tells all four bounce stories exactly once, with their windows', () => {
    const plans = planClientPayments(items(), TODAY, createRng(1));
    for (const story of [
      'bounced-open',
      'bounced-regularized',
      'bounced-closed',
      'bounced-disputed',
    ] as const) {
      expect(
        plans.filter((p) => p.story === story),
        story,
      ).toHaveLength(1);
    }
    const open = plans.find((p) => p.story === 'bounced-open');
    const bounce = open?.events.find((e) => e.event === 'bounced');
    expect(bounce && addDaysIso(bounce.date, 30) >= TODAY).toBe(true); // the window is still open
    const closed = plans.find((p) => p.story === 'bounced-closed');
    expect(addDaysIso(closed?.events.find((e) => e.event === 'bounced')?.date ?? TODAY, 30) < TODAY).toBe(
      true,
    );
    const regularized = plans.find((p) => p.story === 'bounced-regularized');
    const cover = plans.find(
      (p) => p.key === regularized?.events.find((e) => e.event === 'regularized')?.coveringKey,
    );
    expect(cover?.method).toBe('cash');
    expect(cover?.amountCentimes).toBe(regularized?.amountCentimes);
  });

  it('keeps post-dated cheques in the portfolio and presents some early', () => {
    const plans = planClientPayments(items(), TODAY, createRng(1));
    expect(
      plans.some(
        (p) => p.method === 'cheque' && p.writtenDate && p.writtenDate > TODAY && p.events.length === 0,
      ),
    ).toBe(true);
    expect(plans.some((p) => p.story === 'early-deposit')).toBe(true);
  });

  it('issues cheques to suppliers for the next two weeks, the cement one sized for a tight day', () => {
    const plans = planSupplierPayments(SUPPLIERS, TODAY, '2026-07-26', createRng(2), {
      availableCentimes: 90_000_000,
      shortfallCentimes: 4_000_000,
    });
    const upcoming = plans.filter((p) => p.method === 'cheque' && p.events.length === 0);
    expect(upcoming.length).toBe(6);
    for (const p of upcoming)
      expect(p.writtenDate && p.writtenDate > TODAY && p.writtenDate <= addDaysIso(TODAY, 14)).toBe(true);
    expect(plans.find((p) => p.story === 'tight-day')?.amountCentimes).toBe(94_000_000);
  });
});
