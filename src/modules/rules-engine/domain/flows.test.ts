import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import { buildFlows, instrumentDates } from './flows';
import type { InstrumentFact, PlanItemFact } from './types';

const params = { today: '2026-11-02', clearingDelayDays: 1, calendar: NO_HOLIDAYS };

const cheque = (over: Partial<InstrumentFact> = {}): InstrumentFact => ({
  id: 'i1',
  direction: 'in',
  method: 'cheque',
  amount: centimes(100_000),
  state: 'received',
  writtenDate: '2026-11-05',
  receivedDate: '2026-10-28',
  depositedOn: null,
  partyId: 'c1',
  partyName: 'Client',
  label: 'CH 1',
  ...over,
});

const item = (over: Partial<PlanItemFact> = {}): PlanItemFact => ({
  id: 'p1',
  direction: 'in',
  kind: 'order',
  documentId: 'o1',
  documentCode: 'CMD-2026-00001',
  partyId: 'c1',
  partyName: 'Client',
  dueDate: '2026-11-10',
  remaining: centimes(50_000),
  method: 'cheque',
  ...over,
});

describe('instrument dates (SPEC §3.2)', () => {
  it('a cheque in hand is deposited on its written date and clears one working day later', () => {
    expect(instrumentDates(cheque(), params)).toEqual({ baseDate: '2026-11-06', worstDate: '2026-11-06' });
  });

  it('a written date already past counts from today', () => {
    expect(instrumentDates(cheque({ writtenDate: '2026-10-30' }), params).baseDate).toBe('2026-11-03');
  });

  it('a deposited cheque clears after its deposit date plus the delay, never before today', () => {
    expect(instrumentDates(cheque({ state: 'deposited', depositedOn: '2026-11-02' }), params).baseDate).toBe(
      '2026-11-03',
    );
    expect(instrumentDates(cheque({ state: 'deposited', depositedOn: '2026-10-20' }), params).baseDate).toBe(
      '2026-11-02',
    );
  });

  it('the clearing delay is the parameter: two days shift one more working day (AC-RE-14)', () => {
    const two = { ...params, clearingDelayDays: 2 };
    expect(instrumentDates(cheque({ state: 'deposited', depositedOn: '2026-11-02' }), two).baseDate).toBe(
      '2026-11-04',
    );
  });

  it('a Saturday deposit clears on Monday', () => {
    expect(
      instrumentDates(cheque({ state: 'deposited', depositedOn: '2026-11-07' }), {
        ...params,
        today: '2026-11-07',
      }).baseDate,
    ).toBe('2026-11-09');
  });

  it('cash and transfers need no clearing', () => {
    expect(instrumentDates(cheque({ method: 'cash', writtenDate: null }), params).baseDate).toBe(
      '2026-11-02',
    );
    expect(
      instrumentDates(cheque({ method: 'transfer', writtenDate: null, receivedDate: '2026-11-04' }), params)
        .baseDate,
    ).toBe('2026-11-04');
  });

  it('an outgoing post-dated cheque is on its written date, and in the worst case from the day it was issued (AC-RE-02)', () => {
    const out = cheque({
      direction: 'out',
      state: 'issued',
      writtenDate: '2026-11-20',
      receivedDate: '2026-10-31',
    });
    expect(instrumentDates(out, params)).toEqual({ baseDate: '2026-11-20', worstDate: '2026-11-02' });
  });

  it('an outgoing cheque already due has the same date in both scenarios', () => {
    const out = cheque({
      direction: 'out',
      state: 'issued',
      writtenDate: '2026-11-02',
      receivedDate: '2026-10-31',
    });
    expect(instrumentDates(out, params)).toEqual({ baseDate: '2026-11-02', worstDate: '2026-11-02' });
  });
});

describe('buildFlows', () => {
  it('builds incoming flows as probable and outgoing as committed, sorted by date', () => {
    const { flows } = buildFlows(
      [
        cheque(),
        cheque({
          id: 'i2',
          direction: 'out',
          state: 'issued',
          writtenDate: '2026-11-03',
          receivedDate: '2026-11-01',
        }),
      ],
      [],
      params,
    );
    expect(flows.map((f) => [f.id, f.certainty])).toEqual([
      ['instrument:i2', 'committed'],
      ['instrument:i1', 'probable'],
    ]);
    expect(flows[0]?.earlyPresentable).toBe(true);
  });

  it('counts what no allocation covers; a covered item (remaining 0) is not a flow', () => {
    const { flows } = buildFlows([], [item(), item({ id: 'p2', remaining: centimes(0) })], params);
    expect(flows.map((f) => f.id)).toEqual(['plan:p1']);
  });

  it('keeps an overdue receivable out of the flows and lists it apart; an overdue payable is owed today', () => {
    const { flows, overdue } = buildFlows(
      [],
      [
        item({ id: 'late', dueDate: '2026-10-20' }),
        item({ id: 'owed', direction: 'out', kind: 'purchase', dueDate: '2026-10-20' }),
      ],
      params,
    );
    expect(overdue.map((o) => [o.id, o.daysLate])).toEqual([['late', 13]]);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ id: 'plan:owed', baseDate: '2026-11-02', direction: 'out' });
  });

  it('carries the order total and delivery date for the advance option', () => {
    const { flows } = buildFlows(
      [],
      [item({ documentTotal: centimes(1_000_000), deliveryDate: '2026-11-04' })],
      params,
    );
    expect(flows[0]).toMatchObject({ orderTotal: 1_000_000, deliveryDate: '2026-11-04' });
  });
});
