import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  consumptionReport,
  type LoadFact,
  type MovementFact,
  periodKey,
  producedByType,
} from './consumption-report';

describe('periodKey', () => {
  it('day, ISO week and month', () => {
    expect(periodKey('2026-11-02', 'day')).toBe('2026-11-02');
    expect(periodKey('2026-11-02', 'month')).toBe('2026-11');
    // Monday 2 Nov 2026 is the first day of ISO week 45; Sunday 8 Nov the last
    expect(periodKey('2026-11-02', 'week')).toBe('2026-W45');
    expect(periodKey('2026-11-08', 'week')).toBe('2026-W45');
    expect(periodKey('2026-11-09', 'week')).toBe('2026-W46');
    // the week of 1 Jan 2027 (a Friday) belongs to ISO week 53 of 2026
    expect(periodKey('2027-01-01', 'week')).toBe('2026-W53');
  });
});

describe('production per type (AC-OPS-18)', () => {
  const loads: LoadFact[] = [
    { date: '2026-11-02', typeId: 'a', typeLabel: 'B25', volumeL: 8000 },
    { date: '2026-11-02', typeId: 'a', typeLabel: 'B25', volumeL: 4000 },
    { date: '2026-11-02', typeId: 'b', typeLabel: 'B20', volumeL: 6000 },
    // a cancellation of the 4 m³ load counts on the day of the load it cancels
    { date: '2026-11-02', typeId: 'a', typeLabel: 'B25', volumeL: -4000 },
    { date: '2026-11-03', typeId: 'a', typeLabel: 'B25', volumeL: 8000 },
  ];
  it('is the sum of the live loads per type and day, cancellations netted', () => {
    expect(producedByType(loads, 'day')).toEqual([
      { period: '2026-11-02', typeId: 'b', typeLabel: 'B20', volumeL: 6000 },
      { period: '2026-11-02', typeId: 'a', typeLabel: 'B25', volumeL: 8000 },
      { period: '2026-11-03', typeId: 'a', typeLabel: 'B25', volumeL: 8000 },
    ]);
    expect(producedByType(loads, 'week').find((r) => r.typeId === 'a')?.volumeL).toBe(16000);
  });
  it('property: the sum over days equals the sum over loads, whatever the split in periods', () => {
    const load = fc.record({
      date: fc
        .integer({ min: 0, max: 60 })
        .map((n) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10)),
      typeId: fc.constantFrom('a', 'b', 'c'),
      typeLabel: fc.constant('T'),
      volumeL: fc.integer({ min: -9000, max: 9000 }),
    });
    fc.assert(
      fc.property(fc.array(load, { maxLength: 40 }), (ls) => {
        const total = ls.reduce((s, l) => s + l.volumeL, 0);
        for (const p of ['day', 'week', 'month'] as const)
          expect(producedByType(ls, p).reduce((s, r) => s + r.volumeL, 0)).toBe(total);
      }),
    );
  });
});

describe('consumption against the counts (AC-OPS-19)', () => {
  const cement = 'cement';
  // B25, 350 kg/m³, 8 m³: 2 800 000 g taken out
  const base: MovementFact[] = [
    { componentId: cement, date: '2026-11-02', qtyBase: -2_800_000, source: 'delivery' },
  ];

  it('theoretical consumption is the sum of the load movements', () => {
    const [r] = consumptionReport(base, 'day', 200);
    expect(r).toMatchObject({
      theoretical: 2_800_000,
      counted: false,
      actual: null,
      variance: null,
      flagged: false,
    });
  });

  it('a period without a count has no actual figure, never zero', () => {
    expect(consumptionReport(base, 'month', 200)[0]?.actual).toBeNull();
  });

  const withCount = (adjustment: number): MovementFact[] => [
    ...base,
    { componentId: cement, date: '2026-11-02', qtyBase: adjustment, source: 'count_adjustment' },
  ];

  it('an adjustment of −56 000 g on 2 800 000 g is +2,00 %: not flagged at tolerance 200, flagged at 199', () => {
    const at200 = consumptionReport(withCount(-56_000), 'day', 200)[0];
    expect(at200).toMatchObject({ actual: 2_856_000, variance: 56_000, varianceBp: 200, flagged: false });
    expect(consumptionReport(withCount(-56_000), 'day', 199)[0]?.flagged).toBe(true);
  });

  it('a count that finds more than the books is a negative variance, flagged by its size', () => {
    const r = consumptionReport(withCount(84_000), 'day', 200)[0];
    expect(r).toMatchObject({ variance: -84_000, varianceBp: -300, flagged: true });
  });

  it('receipts and openings never enter the variance', () => {
    const r = consumptionReport(
      [
        ...withCount(0),
        { componentId: cement, date: '2026-11-02', qtyBase: 30_000_000, source: 'receipt' },
        { componentId: cement, date: '2026-11-01', qtyBase: 5_000_000, source: 'opening' },
      ],
      'day',
      200,
    );
    expect(r.find((x) => x.period === '2026-11-02')).toMatchObject({ theoretical: 2_800_000, variance: 0 });
  });

  it('a reversal puts the quantity back (the cancelled load consumed nothing)', () => {
    const r = consumptionReport(
      [...base, { componentId: cement, date: '2026-11-02', qtyBase: 2_800_000, source: 'reversal' }],
      'day',
      200,
    );
    expect(r[0]?.theoretical).toBe(0);
  });

  it('a variance against a theoretical of zero is flagged', () => {
    const r = consumptionReport(
      [{ componentId: cement, date: '2026-11-02', qtyBase: -1000, source: 'count_adjustment' }],
      'day',
      200,
    )[0];
    expect(r).toMatchObject({ theoretical: 0, varianceBp: null, flagged: true });
  });

  it('per component and per period: two components and two weeks stay apart', () => {
    const r = consumptionReport(
      [
        { componentId: 'a', date: '2026-11-02', qtyBase: -100, source: 'delivery' },
        { componentId: 'b', date: '2026-11-02', qtyBase: -200, source: 'delivery' },
        { componentId: 'a', date: '2026-11-10', qtyBase: -300, source: 'delivery' },
      ],
      'week',
      200,
    );
    expect(r.map((x) => [x.period, x.componentId, x.theoretical])).toEqual([
      ['2026-W45', 'a', 100],
      ['2026-W45', 'b', 200],
      ['2026-W46', 'a', 300],
    ]);
  });

  it('property: variance = −adjustments, actual = theoretical − adjustments, and the flag is exact', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: -400_000, max: 400_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (theoretical, adjustment, tolerance) => {
          const r = consumptionReport(
            [
              { componentId: 'x', date: '2026-11-02', qtyBase: -theoretical, source: 'delivery' },
              { componentId: 'x', date: '2026-11-02', qtyBase: adjustment, source: 'count_adjustment' },
            ],
            'day',
            tolerance,
          )[0];
          expect(r?.variance).toBe(-adjustment + 0); // + 0: an adjustment of 0 gives 0, not -0
          expect(r?.actual).toBe(theoretical - adjustment);
          expect(r?.flagged).toBe(Math.abs(adjustment) * 10_000 > tolerance * theoretical);
        },
      ),
    );
  });
});
