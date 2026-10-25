import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import { reorderAll, reorderFor } from './reorder';
import {
  type ComponentProjection,
  projectStock,
  type StockDemand,
  type StockRiskInput,
  type SupplierHint,
} from './stock-risk';

// AC-OPS-20, 21: days of cover from the open orders, and a draft purchase when the cover is shorter than the supplier's lead
// time plus the margin. 1 t of cement per m³ here (a round figure), so 4 m³ take 4 t.
const TODAY = '2026-11-02';
const cement = {
  id: 'cem',
  nameFr: 'Ciment',
  nameAr: 'إسمنت',
  baseUnit: 'g',
  level: 10_000_000,
  lowThreshold: 500_000 as number | null,
};
const recettes = new Map([
  ['b25', [{ effectiveFrom: '2026-01-01', lines: [{ componentId: 'cem', qtyPerM3: 1_000_000 }] }]],
]);
const demand = (id: string, date: string, volumeL = 4_000): StockDemand => ({
  orderId: id,
  orderCode: `CMD-${id}`,
  clientCode: 'CLT-001',
  typeId: 'b25',
  typeLabel: 'B25',
  date,
  volumeL,
});
const project = (demands: StockDemand[]): ComponentProjection => {
  const input: StockRiskInput = {
    today: TODAY,
    horizonDays: 10,
    calendar: NO_HOLIDAYS,
    components: [cement],
    demands,
    recettes,
    receipts: [],
  };
  return projectStock(input).components[0] as ComponentProjection;
};
const hint = (leadTimeDays: number | null): SupplierHint => ({
  supplierId: 's1',
  supplierCode: 'FRN-01',
  supplierName: 'Ciments du Nord',
  purchaseUnitId: 'u1',
  unitLabel: 't',
  factorToBase: 1_000_000,
  lastUnitPriceHt: centimes(95_000),
  termDays: 30,
  leadTimeDays,
});
const params = { today: TODAY, fallbackLeadDays: 2, marginDays: 2 };

// 10 t in stock, 4 t on the day, the next day and the day after: 6 t, 2 t, then −2 t
const threeDays = [demand('1', '2026-11-02'), demand('2', '2026-11-03'), demand('3', '2026-11-04')];

describe('days of cover (AC-OPS-20)', () => {
  it('10 t and three days of 4 t: the stock is below zero on the third day, a cover of 2 days', () => {
    const p = project(threeDays);
    expect(p.firstShortage?.date).toBe('2026-11-04');
    const r = reorderFor(p, null, params);
    expect(r.coverDays).toBe(2);
    expect(r.shortageDate).toBe('2026-11-04');
  });

  it('no shortage within the horizon: no cover figure, nothing to order', () => {
    const r = reorderFor(project([demand('1', '2026-11-03')]), hint(3), params);
    expect(r).toMatchObject({
      coverDays: null,
      shortageDate: null,
      needsOrder: false,
      orderBy: null,
      late: false,
      draft: null,
    });
  });
});

describe('reorder suggestion (AC-OPS-20, 21)', () => {
  const short = project(threeDays);

  it('a supplier lead time of 3 days with a margin of 2 triggers it: the cover (2) is below 5; the draft is computed', () => {
    const r = reorderFor(short, hint(3), params);
    expect(r).toMatchObject({ leadDays: 3, leadFrom: 'supplier', needsOrder: true });
    // brings the worst level (−2 t) back to the threshold (0,5 t): 2,5 t, at the last price of 950,00 per t
    expect(r.draft).toMatchObject({ supplierName: 'Ciments du Nord', qtyMilli: 2_500, unitLabel: 't' });
    expect(r.draft?.estimatedHtCentimes).toBe(237_500);
    // order by the shortage date minus the lead time: already past, so late
    expect(r.orderBy).toBe('2026-11-01');
    expect(r.late).toBe(true);
  });

  it('a supplier without a lead time uses the parameter', () => {
    const r = reorderFor(short, hint(null), { ...params, fallbackLeadDays: 4 });
    expect(r).toMatchObject({ leadDays: 4, leadFrom: 'parameter', needsOrder: true });
  });

  it('a long enough cover triggers nothing: no draft, not late', () => {
    const later = project([demand('1', '2026-11-02'), demand('2', '2026-11-08', 7_000)]);
    const r = reorderFor(later, hint(3), params);
    // 8 November 2026 is a Sunday: the demand lands on the next working day, 9 November
    expect(r.coverDays).toBe(7);
    expect(r.needsOrder).toBe(false);
    expect(r.draft).toBeNull();
    expect(r.late).toBe(false);
    // 7 ≥ 3 + 2, but with a longer margin it would
    expect(reorderFor(later, hint(3), { ...params, marginDays: 5 }).needsOrder).toBe(true);
  });

  it('the exact edge: a cover equal to the lead time plus the margin does not trigger', () => {
    expect(reorderFor(short, hint(0), { ...params, marginDays: 2 }).needsOrder).toBe(false);
    expect(reorderFor(short, hint(1), { ...params, marginDays: 2 }).needsOrder).toBe(true);
  });

  it('without a supplier hint (plant, partner) the cover is known and no draft exists', () => {
    const r = reorderFor(short, null, params);
    expect(r.needsOrder).toBe(true);
    expect(r.draft).toBeNull();
  });

  it('is a draft only: the result has no purchase id, nothing was ordered', () => {
    const r = reorderFor(short, hint(3), params);
    expect(Object.keys(r.draft ?? {})).not.toContain('purchaseId');
  });
});

describe('reorderAll', () => {
  it('puts the components to order first, the shortest cover first', () => {
    const urgent = { ...project(threeDays), componentId: 'a' };
    const fine = { ...project([demand('1', '2026-11-03')]), componentId: 'b' };
    const soon = {
      ...project([demand('1', '2026-11-02'), demand('2', '2026-11-03', 8_000)]),
      componentId: 'c',
    };
    const list = reorderAll([fine, urgent, soon], new Map(), params);
    expect(list.map((r) => r.componentId)).toEqual(['c', 'a', 'b']);
  });
});
