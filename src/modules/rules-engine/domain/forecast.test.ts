import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { centimes } from '@/lib/money';
import { detectBlackDay } from './black-day';
import { NO_HOLIDAYS } from './calendar';
import { firstDeficit, forecastCash, lowestDay, shortfallOf } from './forecast';
import type { CashFlow } from './types';

const flow = (over: Partial<CashFlow> & { id: string }): CashFlow => ({
  direction: 'in',
  amount: centimes(100),
  baseDate: '2026-11-03',
  worstDate: over.baseDate ?? '2026-11-03',
  certainty: 'probable',
  source: 'plan',
  method: 'cheque',
  instrumentState: null,
  ref: { type: 'order', id: 'o', code: 'CMD-1' },
  partyId: 'p',
  partyName: 'Party',
  earlyPresentable: false,
  ...over,
});

const input = (flows: CashFlow[], over = {}) => ({
  today: '2026-11-02',
  horizonDays: 5,
  encaisse: centimes(1_000),
  threshold: centimes(0),
  flows,
  calendar: NO_HOLIDAYS,
  ...over,
});

describe('forecastCash', () => {
  it('lists today and the next working days with the opening cash when nothing moves', () => {
    const days = forecastCash(input([]));
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
    expect(days.every((d) => d.base === 1_000 && d.worst === 1_000)).toBe(true);
  });

  it('adds inflows and subtracts outflows from their day on', () => {
    const days = forecastCash(
      input([
        flow({ id: 'a', amount: centimes(300), baseDate: '2026-11-03' }),
        flow({ id: 'b', direction: 'out', amount: centimes(500), baseDate: '2026-11-05' }),
      ]),
    );
    expect(days.map((d) => d.base)).toEqual([1_000, 1_300, 1_300, 800, 800, 800]);
    expect(days[1]?.inflow).toBe(300);
    expect(days[3]?.outflow).toBe(500);
    expect(days[3]?.events.map((e) => e.flowId)).toEqual(['b']);
  });

  it('a flow dated on a day off lands on the next working day', () => {
    const days = forecastCash(input([flow({ id: 'a', baseDate: '2026-11-08' })], { horizonDays: 7 }));
    const monday = days.find((d) => d.date === '2026-11-09');
    expect(monday?.events[0]?.onDate).toBe('2026-11-08');
    expect(monday?.base).toBe(1_100);
  });

  it('a late flow counts on today; a flow beyond the horizon is ignored', () => {
    const days = forecastCash(
      input([
        flow({ id: 'late', direction: 'out', amount: centimes(200), baseDate: '2026-10-30' }),
        flow({ id: 'far', baseDate: '2026-12-31' }),
      ]),
    );
    expect(days[0]?.base).toBe(800);
    expect(days.at(-1)?.base).toBe(800);
  });

  it('an outgoing post-dated cheque is on its written date in base and on today in worst (AC-RE-02)', () => {
    const days = forecastCash(
      input([
        flow({
          id: 'chq',
          direction: 'out',
          amount: centimes(400),
          baseDate: '2026-11-05',
          worstDate: '2026-11-02',
          earlyPresentable: true,
        }),
      ]),
    );
    expect(days[0]?.base).toBe(1_000);
    expect(days[0]?.worst).toBe(600);
    expect(days[3]?.base).toBe(600);
    expect(days[0]?.worstOnlyEvents.map((e) => e.flowId)).toEqual(['chq']);
    expect(days[3]?.worstOnlyEvents).toEqual([]);
    expect(days[3]?.events[0]?.earlyPresentable).toBe(true);
  });

  it('is deterministic whatever the order of the flows (AC-RE-01)', () => {
    const flowArb = fc.record({
      n: fc.integer({ min: 0, max: 5 }),
      out: fc.boolean(),
      amount: fc.integer({ min: 1, max: 100_000 }),
      day: fc.integer({ min: 0, max: 12 }),
    });
    fc.assert(
      fc.property(fc.array(flowArb, { maxLength: 15 }), (rows) => {
        const flows = rows.map((r, i) =>
          flow({
            id: `f${i}`,
            direction: r.out ? 'out' : 'in',
            amount: centimes(r.amount),
            baseDate: `2026-11-${String(2 + r.day).padStart(2, '0')}`,
          }),
        );
        const a = forecastCash(input(flows, { horizonDays: 14 }));
        const b = forecastCash(input([...flows].reverse(), { horizonDays: 14 }));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        // the worst case never beats the normal one
        expect(a.every((d) => d.worst <= d.base)).toBe(true);
      }),
    );
  });
});

describe('lowest day, first deficit and the black day', () => {
  const flows = [
    flow({ id: 'in', amount: centimes(200), baseDate: '2026-11-03' }),
    flow({
      id: 'big',
      direction: 'out',
      amount: centimes(1_600),
      baseDate: '2026-11-05',
      ref: { type: 'purchase', id: 'x', code: 'ACH-1' },
    }),
    flow({
      id: 'small',
      direction: 'out',
      amount: centimes(100),
      baseDate: '2026-11-05',
      ref: { type: 'purchase', id: 'y', code: 'ACH-2' },
    }),
    flow({ id: 'back', amount: centimes(1_000), baseDate: '2026-11-07' }),
  ];
  const days = forecastCash(input(flows));

  it('finds the lowest day and the first deficit', () => {
    expect(lowestDay(days, 'base')).toEqual({ date: '2026-11-05', balance: -500 });
    expect(firstDeficit(days, 'base', centimes(0))?.date).toBe('2026-11-05');
    expect(shortfallOf(centimes(-500), centimes(0))).toBe(500);
    expect(shortfallOf(centimes(500), centimes(0))).toBe(0);
  });

  it('flags the black day as a risk with its largest outflows as causes (AC-RE-04)', () => {
    const black = detectBlackDay(days, centimes(0));
    expect(black).toMatchObject({ date: '2026-11-05', severity: 'risk', scenario: 'base', shortfall: 500 });
    expect(black?.causes.map((c) => c.code)).toEqual(['ACH-1', 'ACH-2']);
    expect(black?.outflowTotal).toBe(1_700);
  });

  it('a threshold change changes the result (AC-RE-04)', () => {
    expect(detectBlackDay(days, centimes(-600))).toBeNull();
    expect(detectBlackDay(days, centimes(50_000))?.date).toBe('2026-11-02');
  });

  it('a worst-case-only deficit is urgent, never a risk (AC-RE-13)', () => {
    const only = forecastCash(
      input([
        flow({ id: 'cash-in', amount: centimes(1_000), baseDate: '2026-11-03' }),
        flow({
          id: 'chq',
          direction: 'out',
          amount: centimes(1_500),
          baseDate: '2026-11-06',
          worstDate: '2026-11-02',
          earlyPresentable: true,
        }),
      ]),
    );
    const black = detectBlackDay(only, centimes(0));
    expect(black).toMatchObject({ severity: 'urgent', scenario: 'worst', date: '2026-11-02' });
    expect(black?.causes.map((c) => c.flowId)).toEqual(['chq']);
  });

  it('there is no black day when every day is above the threshold', () => {
    expect(detectBlackDay(forecastCash(input([])), centimes(0))).toBeNull();
  });
});
