import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { type PlanItemInput, splitPlan } from './plan';

const pct = (
  percentBp: number,
  dueDate: string,
  method: PlanItemInput['method'] = 'cheque',
): PlanItemInput => ({
  method,
  dueDate,
  share: { percentBp },
});

describe('splitPlan (AC-LED-01, AC-LED-02)', () => {
  it('20 / 40 / 40 of 112 320,00 → 22 464,00 / 44 928,00 / 44 928,00', () => {
    const r = splitPlan(centimes(11_232_000), [
      pct(2000, '2026-11-01', 'advance'),
      pct(4000, '2026-12-01'),
      pct(4000, '2027-01-01'),
    ]);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.value.map((i) => i.amount)).toEqual([2_246_400, 4_492_800, 4_492_800]);
  });

  it('the last item absorbs the rounding (1 / 3 each of 100,00)', () => {
    const r = splitPlan(centimes(10_000), [
      pct(3333, '2026-11-01'),
      pct(3333, '2026-12-01'),
      pct(3334, '2027-01-01'),
    ]);
    expect(r.ok && r.value.map((i) => i.amount)).toEqual([3333, 3333, 3334]);
    const odd = splitPlan(centimes(10_001), [pct(5000, '2026-11-01'), pct(5000, '2026-12-01')]);
    expect(odd.ok && odd.value.map((i) => i.amount)).toEqual([5001, 5000]);
  });

  it('fixed amounts must add up to the total: a plan that does not is an Err (AC-LED-02)', () => {
    const items = (a: number, b: number): PlanItemInput[] => [
      { method: 'cash', dueDate: '2026-11-01', share: { amount: centimes(a) } },
      { method: 'cheque', dueDate: '2026-12-01', share: { amount: centimes(b) } },
    ];
    expect(splitPlan(centimes(10_000), items(4000, 6000))).toMatchObject({ ok: true });
    expect(splitPlan(centimes(10_000), items(4000, 5999))).toEqual({ ok: false, error: 'SUM_MISMATCH' });
    expect(splitPlan(centimes(10_000), items(4000, 6001))).toEqual({ ok: false, error: 'SUM_MISMATCH' });
  });

  it.each([
    [
      'percentages not adding to 100 %',
      [pct(5000, '2026-11-01'), pct(4000, '2026-12-01')],
      'PERCENT_SUM_NOT_100',
    ],
    ['an empty plan', [], 'EMPTY_PLAN'],
    ['a bad date', [pct(10_000, '2026-13-01')], 'INVALID_ITEM'],
    ['a zero share', [pct(0, '2026-11-01'), pct(10_000, '2026-12-01')], 'INVALID_ITEM'],
    [
      'percent and fixed mixed',
      [pct(5000, '2026-11-01'), { method: 'cash', dueDate: '2026-12-01', share: { amount: centimes(5000) } }],
      'MIXED_SHARES',
    ],
  ] as const)('refuses %s', (_label, items, error) => {
    expect(splitPlan(centimes(10_000), items as never)).toEqual({ ok: false, error });
  });

  it('refuses a total that is not positive', () => {
    expect(splitPlan(centimes(0), [pct(10_000, '2026-11-01')])).toEqual({
      ok: false,
      error: 'INVALID_TOTAL',
    });
  });

  it('property: for any total and any split, Σ items = total exactly', () => {
    const shares = fc
      .array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 })
      .map((raw) => {
        const sum = raw.reduce((a, b) => a + b, 0);
        const bps = raw.map((r) => Math.max(1, Math.floor((r * 10_000) / sum)));
        bps[bps.length - 1] = 10_000 - bps.slice(0, -1).reduce((a, b) => a + b, 0);
        return bps;
      })
      .filter((bps) => bps.every((bp) => bp > 0));
    fc.assert(
      fc.property(fc.integer({ min: 100_000, max: 900_000_000_000 }), shares, (total, bps) => {
        const r = splitPlan(
          centimes(total),
          bps.map((bp, n) => pct(bp, `2026-11-${String(n + 1).padStart(2, '0')}`)),
        );
        return r.ok && r.value.reduce((s, i) => s + i.amount, 0) === total;
      }),
    );
  });

  it('property: fixed amounts that add up are accepted, any other total is refused', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 50 }),
        (amounts, skew) => {
          const total = amounts.reduce((a, b) => a + b, 0);
          const items = amounts.map((a) => ({
            method: 'cash' as const,
            dueDate: '2026-11-01',
            share: { amount: centimes(a) },
          }));
          return splitPlan(centimes(total), items).ok && !splitPlan(centimes(total + skew), items).ok;
        },
      ),
    );
  });
});
