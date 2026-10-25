import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { centimes } from '@/lib/money';
import { settleInvoices } from './invoice-payment';

const inv = (id: string, date: string, total: number) => ({
  id,
  date,
  number: `FA-${id}`,
  totalTtcCentimes: centimes(total),
});

describe('settleInvoices', () => {
  const two = [inv('2', '2026-10-10', 600), inv('1', '2026-10-01', 1_000)];

  it('pays the oldest invoice first, then the next', () => {
    const m = settleInvoices(two, 1_300);
    expect(m.get('1')).toEqual({ state: 'paid', paidCentimes: 1_000 });
    expect(m.get('2')).toEqual({ state: 'partial', paidCentimes: 300 });
  });

  it('nothing covered: every invoice is unpaid; everything covered (or more): every invoice is paid', () => {
    expect([...settleInvoices(two, 0).values()].every((p) => p.state === 'unpaid')).toBe(true);
    expect([...settleInvoices(two, 99_999).values()].every((p) => p.state === 'paid')).toBe(true);
  });

  it('a partly covered first invoice leaves the second unpaid', () => {
    const m = settleInvoices(two, 400);
    expect(m.get('1')?.state).toBe('partial');
    expect(m.get('2')?.state).toBe('unpaid');
  });

  it('a negative cover counts as none, and ties on the date go by the number', () => {
    expect(settleInvoices(two, -5).get('1')?.state).toBe('unpaid');
    const tie = settleInvoices([inv('b', '2026-10-01', 100), inv('a', '2026-10-01', 100)], 100);
    expect(tie.get('a')?.state).toBe('paid');
    expect(tie.get('b')?.state).toBe('unpaid');
  });

  it('never pays more than was covered and never more than a total (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 80_000 }),
        (totals, covered) => {
          const invoices = totals.map((t, i) => inv(String(i), `2026-10-0${i + 1}`, t));
          const m = settleInvoices(invoices, covered);
          const paid = [...m.values()].reduce((s, p) => s + p.paidCentimes, 0);
          expect(paid).toBe(
            Math.min(
              covered,
              totals.reduce((a, b) => a + b, 0),
            ),
          );
          for (const i of invoices) expect(m.get(i.id)?.paidCentimes).toBeLessThanOrEqual(i.totalTtcCentimes);
        },
      ),
    );
  });
});
