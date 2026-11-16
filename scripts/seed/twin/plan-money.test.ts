import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/modules/ledger/domain/scenario.ts';
import { planClientPayment, planSupplierPayment, type PlanItem } from './plan-money.ts';

const anchor = '2026-11-15';
const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  itemId: 'i',
  method: 'cheque',
  due: '2026-10-20',
  amount: 1_000_000,
  deliveryDate: '2026-09-20',
  ...over,
});

describe('how the twin pays (T20)', () => {
  it('is deterministic and never dates anything after the anchor', () => {
    for (const behaviour of ['good', 'slow', 'late', 'bad'] as const)
      for (let k = 0; k < 200; k++) {
        const a = planClientPayment(
          item({
            method: ['cash', 'advance', 'installment', 'cheque', 'lcn'][k % 5]!,
            due: `2026-${k % 2 ? '09' : '10'}-${String(1 + (k % 27)).padStart(2, '0')}`,
          }),
          behaviour,
          createRng(k),
          anchor,
        );
        const b = planClientPayment(
          item({
            method: ['cash', 'advance', 'installment', 'cheque', 'lcn'][k % 5]!,
            due: `2026-${k % 2 ? '09' : '10'}-${String(1 + (k % 27)).padStart(2, '0')}`,
          }),
          behaviour,
          createRng(k),
          anchor,
        );
        expect(a).toEqual(b);
        if (!a) continue;
        for (const d of [a.received, a.deposit, a.clear, a.bounce]) if (d) expect(d <= anchor).toBe(true);
        expect(a.amount).toBeGreaterThan(0);
        expect(a.amount).toBeLessThanOrEqual(1_000_000);
        if (a.deposit) expect(a.deposit >= a.received).toBe(true);
        if (a.clear && a.deposit) expect(a.clear >= a.deposit).toBe(true);
      }
  });

  it('makes good clients pay near the due date and bad ones mostly not at all', () => {
    const paid = (b: 'good' | 'bad') => {
      let n = 0;
      for (let k = 0; k < 400; k++)
        if (planClientPayment(item({ method: 'cash', due: '2026-10-01' }), b, createRng(k + 1000), anchor))
          n += 1;
      return n;
    };
    expect(paid('good')).toBe(400);
    expect(paid('bad')).toBeLessThan(300);
  });

  it('leaves cheques with a due date in the next days handed over and not yet deposited', () => {
    const stories = Array.from({ length: 300 }, (_, k) =>
      planClientPayment(
        item({ method: 'cheque', due: '2026-11-20', deliveryDate: '2026-10-21' }),
        'good',
        createRng(k),
        anchor,
      ),
    ).filter(Boolean);
    expect(stories.length).toBeGreaterThan(200);
    for (const s of stories) {
      expect(s!.deposit).toBeNull();
      expect(s!.written! >= s!.received).toBe(true);
    }
  });

  it('pays suppliers by cheque, LCN or transfer, some late, some not yet', () => {
    const outcomes = Array.from({ length: 300 }, (_, k) =>
      planSupplierPayment(
        item({
          method: ['cheque', 'lcn', 'transfer'][k % 3]!,
          due: '2026-11-05',
          deliveryDate: '2026-09-20',
        }),
        createRng(k),
        anchor,
      ),
    );
    expect(outcomes.filter((o) => o === null).length).toBeGreaterThan(20);
    expect(outcomes.filter((o) => o?.method === 'lcn').length).toBeGreaterThan(50);
    for (const o of outcomes) if (o) expect(o.received <= anchor).toBe(true);
  });
});
