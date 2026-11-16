import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/modules/ledger/domain/scenario.ts';
import { addDays } from './context.ts';
import { planReceipts } from './plan-stock.ts';

const consumption = (n: number, f: (i: number) => number) => {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i++) m.set(addDays('2026-09-01', i), f(i));
  return m;
};
const base = {
  start: '2026-09-01',
  end: '2026-11-15',
  unit: 1_000_000,
  reorderDays: 5,
  lotDays: 9,
  leadDays: 2,
};

describe('the stock plan (T20)', () => {
  it('never lets a component go below zero, whatever the use', () => {
    for (const [name, f] of [
      ['steady', () => 30_000_000],
      ['spiky', (i: number) => (i % 11 === 0 ? 140_000_000 : 12_000_000)],
      ['a big first week', (i: number) => (i < 7 ? 90_000_000 : 8_000_000)],
    ] as const) {
      const c = consumption(76, f);
      const plan = planReceipts({ ...base, consumption: c }, createRng(5));
      let level = plan.opening;
      const by = new Map<string, number>();
      for (const r of plan.receipts) by.set(r.receiptDate, (by.get(r.receiptDate) ?? 0) + r.qty);
      for (let d = base.start; d <= base.end; d = addDays(d, 1)) {
        level += by.get(d) ?? 0;
        level -= c.get(d) ?? 0;
        expect(level, `${name} on ${d}`).toBeGreaterThanOrEqual(0);
      }
      expect(plan.minLevel).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic, buys whole units, and receives on working days', () => {
    const c = consumption(76, () => 25_000_000);
    const a = planReceipts({ ...base, consumption: c }, createRng(9));
    expect(a).toEqual(planReceipts({ ...base, consumption: c }, createRng(9)));
    expect(a.receipts.length).toBeGreaterThan(5);
    for (const r of a.receipts) {
      expect(r.qty % base.unit).toBe(0);
      expect(new Date(`${r.receiptDate}T00:00:00Z`).getUTCDay()).not.toBe(0);
      expect(r.receiptDate > r.orderDate).toBe(true);
    }
  });
});
