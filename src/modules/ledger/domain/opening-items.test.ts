import { describe, expect, it } from 'vitest';
import { addAging, ageEntries, bucketOf, daysBetween, type OpeningItem, splitOpening } from './opening-items';

const item = (n: string, due: string, bal: number): OpeningItem => ({
  invoiceNumber: n,
  invoiceDate: '2026-09-01',
  dueDate: due,
  balanceCentimes: bal,
});

describe('bucketOf (the arithmetic twin of the aging screen)', () => {
  const today = '2026-12-15';
  it.each([
    ['2026-12-15', 'current'], // due today: not yet late
    ['2027-01-30', 'current'],
    ['2026-12-14', 'd1_30'], // 1 day late
    ['2026-11-15', 'd1_30'], // 30 days late
    ['2026-11-14', 'd31_60'], // 31
    ['2026-10-16', 'd31_60'], // 60
    ['2026-10-15', 'd61_90'], // 61
    ['2026-09-16', 'd61_90'], // 90
    ['2026-09-15', 'd90plus'], // 91
    [null, 'unknown'],
  ] as const)('due %s is %s', (due, bucket) => expect(bucketOf(due, today)).toBe(bucket));
  it('counts calendar days across a month end and a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('splitOpening', () => {
  it('items that cover the line leave no remainder; no credit leaves every balance', () => {
    const s = splitOpening(1500, [item('F2', '2026-11-20', 500), item('F1', '2026-10-01', 1000)], 0);
    expect(s.items.map((i) => [i.invoiceNumber, i.openCentimes])).toEqual([
      ['F1', 1000],
      ['F2', 500],
    ]);
    expect(s.remainderCentimes).toBe(0);
  });
  it('a line with no items is one remainder (aging unknown), never doubled', () => {
    const s = splitOpening(7000, [], 0);
    expect(s.items).toEqual([]);
    expect(s.remainderCentimes).toBe(7000);
  });
  it('the difference between the line and the items is the remainder', () => {
    const s = splitOpening(2000, [item('F1', '2026-10-01', 1200)], 0);
    expect(s.remainderCentimes).toBe(800);
  });
  it('credit is applied oldest due first, then to the remainder, and what is left over is reported', () => {
    const items = [item('F1', '2026-10-01', 1000), item('F2', '2026-11-01', 1000)];
    const a = splitOpening(2500, items, 1400);
    expect(a.items.map((i) => [i.invoiceNumber, i.openCentimes])).toEqual([['F2', 600]]);
    expect(a.remainderCentimes).toBe(500);
    const b = splitOpening(2500, items, 2200);
    expect(b.items).toEqual([]);
    expect(b.remainderCentimes).toBe(300);
    const c = splitOpening(2000, items, 9000);
    expect(c.creditLeftCentimes).toBe(7000);
  });
  it('the sum of what is open plus the credit used is always the line', () => {
    const items = [item('F1', '2026-10-01', 333), item('F2', '2026-11-01', 777), item('F3', '2026-11-01', 1)];
    for (const credit of [0, 1, 334, 1000, 1111, 5000]) {
      const s = splitOpening(1500, items, credit);
      const open = s.items.reduce((t, i) => t + i.openCentimes, 0) + s.remainderCentimes;
      expect(open + (credit - s.creditLeftCentimes)).toBe(1500);
    }
  });
  it('refuses items that add up to more than the line', () => {
    expect(() => splitOpening(100, [item('F1', '2026-10-01', 101)], 0)).toThrow();
  });
});

describe('ageEntries', () => {
  it('puts each entry in its bucket and the total is the sum of the buckets', () => {
    const row = ageEntries(
      [
        { dueDate: '2026-12-20', openCentimes: 100, origin: 'plan_item' },
        { dueDate: '2026-12-01', openCentimes: 200, origin: 'opening_item' },
        { dueDate: '2026-10-20', openCentimes: 400, origin: 'opening_item' },
        { dueDate: '2026-09-01', openCentimes: 800, origin: 'opening_item' },
        { dueDate: null, openCentimes: 1600, origin: 'opening_line' },
        { dueDate: '2026-01-01', openCentimes: 0, origin: 'plan_item' },
      ],
      '2026-12-15',
    );
    expect(row).toMatchObject({
      current: 100,
      d1_30: 200,
      d31_60: 400,
      d90plus: 800,
      unknown: 1600,
      total: 3100,
    });
    expect(addAging(row, row).total).toBe(6200);
  });
});
