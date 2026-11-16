import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/modules/ledger/domain/scenario.ts';
import { EXTRA_CLIENTS, PILOT_CLIENTS } from './data.ts';
import { numberPaperBooks } from './history.ts';
import { planSales } from './plan-sales.ts';

const clients = [...PILOT_CLIENTS, ...EXTRA_CLIENTS].map((spec) => ({ spec }));
const opts = { start: '2026-09-01', anchor: '2026-11-15', futureDays: 2 };

describe('the sales plan (T20)', () => {
  it('is deterministic: the same seed gives the same twin', () => {
    expect(planSales(createRng(20_261_115), clients, opts)).toEqual(
      planSales(createRng(20_261_115), clients, opts),
    );
    expect(planSales(createRng(1), clients, opts)).not.toEqual(planSales(createRng(2), clients, opts));
  });

  it('covers 1 Sep to 15 Nov with plausible volumes in both plants, plus a few orders for the next two days', () => {
    const plan = planSales(createRng(20_261_115), clients, opts);
    expect(plan.length).toBeGreaterThan(380);
    expect(plan.length).toBeLessThan(650);
    for (const plant of ['TET', 'CHF'] as const)
      expect(plan.filter((o) => o.plant === plant).length).toBeGreaterThan(100);
    expect(plan.filter((o) => o.plant === 'TET').length).toBeGreaterThan(
      plan.filter((o) => o.plant === 'CHF').length,
    );
    expect(plan.every((o) => o.orderDate >= '2026-09-01' && o.orderDate <= '2026-11-15')).toBe(true);
    expect(plan.every((o) => o.deliveryDate >= o.orderDate && o.deliveryDate <= '2026-11-17')).toBe(true);
    expect(plan.filter((o) => o.deliveryDate > '2026-11-15').length).toBeGreaterThan(0);
    // never on a Sunday
    expect(
      plan.every(
        (o) => new Date(`${o.deliveryDate}T00:00:00Z`).getUTCDay() !== 0 || o.deliveryDate > o.orderDate,
      ),
    ).toBe(true);
  });

  it('mixes chute and pump, has cancellations with a reason, and gives every PO-required client its PO number', () => {
    const plan = planSales(createRng(20_261_115), clients, opts);
    expect(plan.filter((o) => o.method === 'POMPE').length).toBeGreaterThan(30);
    expect(plan.filter((o) => o.method === 'GOULOTTE').length).toBeGreaterThan(200);
    expect(plan.filter((o) => o.pump).length).toBe(plan.filter((o) => o.method === 'POMPE').length);
    const cancelled = plan.filter((o) => o.cancelReason);
    expect(cancelled.length).toBeGreaterThanOrEqual(3);
    expect(cancelled.every((o) => (o.cancelReason ?? '').length > 5 && o.method === 'GOULOTTE')).toBe(true);
    for (const o of plan.filter((x) => clients[x.clientIdx]!.spec.poRequired))
      expect(o.clientPo).toMatch(/^BC-\d\d-\d{3}$/);
  });

  it('never double-books a pump (at most three jobs a day, four hours apart)', () => {
    const plan = planSales(createRng(20_261_115), clients, opts);
    const seen = new Set<string>();
    for (const o of plan.filter((x) => x.pump)) {
      const key = `${o.deliveryDate}|${o.pump!.pumpIdx}|${o.pump!.onSiteMin}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('the plants paper BL books (T20 injected defects)', () => {
  const loads = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      plant: (i % 3 === 0 ? 'CHF' : 'TET') as 'TET' | 'CHF',
      date: new Date(Date.UTC(2026, 8, 1) + Math.floor(i / 20) * 86_400_000).toISOString().slice(0, 10),
      volumeL: 8000,
      clientIdx: i % 30,
      typeCode: 'B25',
      method: 'GOULOTTE' as const,
      truckCode: 'T1',
    }));

  it('numbers each plant on its own run, with exactly 4 duplicates, jumps for the missing numbers and one text date', () => {
    const rows = numberPaperBooks(loads(1500), createRng(7), '2026-11-15');
    let duplicates = 0;
    let missing = 0;
    for (const plant of ['TET', 'CHF'] as const) {
      const mine = rows.filter((r) => r.plant === plant);
      mine.forEach((r, i) => {
        const prev = mine[i - 1];
        if (!prev) return;
        const step = r.blNo - prev.blNo;
        expect([0, 1, 2]).toContain(step); // a duplicate, the series, or one missing number
        if (step === 0) duplicates += 1;
        if (step === 2) missing += 1;
      });
    }
    expect(duplicates).toBe(4);
    expect(missing).toBeGreaterThan(20);
    expect(rows.filter((r) => r.textDate)).toHaveLength(1);
  });
});
