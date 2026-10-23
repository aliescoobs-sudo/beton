import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { splitPlan } from './plan';
import { PLAN_PRESETS, presetItems } from './plan-presets';

const dates = { orderDate: '2026-06-01', deliveryDate: '2026-06-10' };

describe('plan presets', () => {
  it.each(PLAN_PRESETS.filter((p) => p !== 'custom'))('%s adds up to the total exactly', (preset) => {
    for (const total of [1, 99, 10_000, 11_232_000, 123_456_789]) {
      const r = splitPlan(centimes(total), presetItems(preset, dates));
      // A tiny total cannot be split into several non-zero items: refused, never a zero item.
      if (r.ok) expect(r.value.reduce((s, i) => s + i.amount, 0)).toBe(total);
      else expect(total).toBeLessThan(3);
    }
  });

  it('cash: all on the delivery date; advance50: half now, half on delivery', () => {
    expect(presetItems('cash', dates)).toEqual([
      { method: 'cash', dueDate: '2026-06-10', share: { percentBp: 10_000 } },
    ]);
    const advance = splitPlan(centimes(10_001), presetItems('advance50', dates));
    expect(advance.ok && advance.value.map((i) => [i.method, i.dueDate, i.amount])).toEqual([
      ['advance', '2026-06-01', 5001],
      ['cash', '2026-06-10', 5000],
    ]);
  });

  it('installments3: thirds due 30, 60 and 90 days after delivery; cheque30: one cheque after 30 days', () => {
    expect(presetItems('installments3', dates).map((i) => i.dueDate)).toEqual([
      '2026-07-10',
      '2026-08-09',
      '2026-09-08',
    ]);
    expect(presetItems('cheque30', dates)).toEqual([
      { method: 'cheque', dueDate: '2026-07-10', share: { percentBp: 10_000 } },
    ]);
  });
});
