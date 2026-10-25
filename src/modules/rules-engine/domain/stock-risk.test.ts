import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import {
  draftPurchase,
  projectStock,
  recetteInForce,
  splitDemand,
  type StockDemand,
  type StockRiskInput,
  type SupplierHint,
} from './stock-risk';

const cement = {
  id: 'cem',
  nameFr: 'Ciment',
  nameAr: 'إسمنت',
  baseUnit: 'g',
  level: 3_000_000,
  lowThreshold: 500_000 as number | null,
};
const sand = {
  id: 'sand',
  nameFr: 'Sable',
  nameAr: 'رمل',
  baseUnit: 'g',
  level: 90_000_000,
  lowThreshold: null,
};

const b25 = [
  {
    effectiveFrom: '2026-01-01',
    lines: [
      { componentId: 'cem', qtyPerM3: 350_000 },
      { componentId: 'sand', qtyPerM3: 800_000 },
    ],
  },
];

const demand = (over: Partial<StockDemand> & { orderId: string }): StockDemand => ({
  orderCode: `CMD-${over.orderId}`,
  clientCode: 'CLT-001',
  typeId: 'b25',
  typeLabel: 'B25',
  date: '2026-11-03',
  volumeL: 8_000,
  ...over,
});

const input = (over: Partial<StockRiskInput> = {}): StockRiskInput => ({
  today: '2026-11-02',
  horizonDays: 5,
  calendar: NO_HOLIDAYS,
  components: [cement, sand],
  demands: [],
  recettes: new Map([['b25', b25]]),
  receipts: [],
  ...over,
});

const projectionOf = (r: ReturnType<typeof projectStock>, id: string) => {
  const p = r.components.find((c) => c.componentId === id);
  if (!p) throw new Error(`no projection for ${id}`);
  return p;
};

describe('projectStock', () => {
  it('keeps the level flat when no order is open', () => {
    const cem = projectionOf(projectStock(input()), 'cem');
    expect(cem.days.every((d) => d.level === 3_000_000)).toBe(true);
    expect(cem.firstShortage).toBeNull();
    expect(cem.firstLow).toBeNull();
    expect(cem.daysUntilShortage).toBeNull();
  });

  it('takes the recette of each order off the stock on its delivery day (one rounding per line)', () => {
    const r = projectStock(
      input({
        demands: [
          demand({ orderId: '1', date: '2026-11-03' }),
          demand({ orderId: '2', date: '2026-11-05', volumeL: 6_000 }),
        ],
      }),
    );
    const cem = projectionOf(r, 'cem');
    expect(cem.days.map((d) => d.level)).toEqual([
      3_000_000, 200_000, 200_000, -1_900_000, -1_900_000, -1_900_000,
    ]);
    expect(cem.needs).toBe(4_900_000);
    expect(cem.firstShortage).toEqual({ date: '2026-11-05', level: -1_900_000 });
    expect(cem.daysUntilShortage).toBe(3);
    expect(cem.maxShortage).toBe(1_900_000);
    expect(cem.contributions.map((c) => [c.orderCode, c.qty])).toEqual([
      ['CMD-1', 2_800_000],
      ['CMD-2', 2_100_000],
    ]);
  });

  it('flags a low level (below the threshold, not negative) and reports the shortage rather than the low', () => {
    // 3 000 000 − 7 × 350 000 = 550 000: above the 500 000 threshold, so not low yet
    const fine = projectionOf(
      projectStock(input({ demands: [demand({ orderId: '1', volumeL: 7_000 })] })),
      'cem',
    );
    expect(fine.firstLow).toBeNull();
    // 3 000 000 − 8 × 350 000 = 200 000: low, not short
    const low = projectionOf(projectStock(input({ demands: [demand({ orderId: '1' })] })), 'cem');
    expect(low.firstLow).toEqual({ date: '2026-11-03', level: 200_000 });
    expect(low.firstShortage).toBeNull();
    // short: the shortage is reported, the low is not
    const short = projectionOf(
      projectStock(input({ demands: [demand({ orderId: '1', volumeL: 12_000 })] })),
      'cem',
    );
    expect(short.firstShortage).toEqual({ date: '2026-11-03', level: -1_200_000 });
    expect(short.firstLow).toBeNull();
  });

  it('counts a late order on today, and ignores one beyond the horizon', () => {
    const r = projectStock(
      input({
        demands: [
          demand({ orderId: '1', date: '2026-10-30', volumeL: 1_000 }),
          demand({ orderId: '2', date: '2026-12-30' }),
        ],
      }),
    );
    const cem = projectionOf(r, 'cem');
    expect(cem.days[0]?.level).toBe(2_650_000);
    expect(cem.needs).toBe(350_000);
  });

  it('adds the receipts expected, never before today', () => {
    const r = projectStock(
      input({
        demands: [demand({ orderId: '1', date: '2026-11-03', volumeL: 12_000 })],
        receipts: [
          {
            purchaseId: 'p',
            purchaseCode: 'ACH-1',
            componentId: 'cem',
            qtyBase: 5_000_000,
            date: '2026-10-31',
          },
        ],
      }),
    );
    const cem = projectionOf(r, 'cem');
    expect(cem.days[0]?.level).toBe(8_000_000);
    expect(cem.days[1]?.level).toBe(3_800_000);
    expect(cem.expectedReceipts).toBe(5_000_000);
    expect(cem.firstShortage).toBeNull();
  });

  it('uses the recette version in force on the day of the load, never a later one', () => {
    const versions = [
      { effectiveFrom: '2026-01-01', lines: [{ componentId: 'cem', qtyPerM3: 300_000 }] },
      { effectiveFrom: '2026-11-04', lines: [{ componentId: 'cem', qtyPerM3: 400_000 }] },
    ];
    const r = projectStock(
      input({
        recettes: new Map([['b25', versions]]),
        demands: [
          demand({ orderId: '1', date: '2026-11-03', volumeL: 1_000 }),
          demand({ orderId: '2', date: '2026-11-05', volumeL: 1_000 }),
        ],
      }),
    );
    expect(projectionOf(r, 'cem').contributions.map((c) => c.qty)).toEqual([300_000, 400_000]);
    expect(recetteInForce(versions, '2025-12-31')).toBeNull();
    expect(recetteInForce(versions, '2026-11-04')?.lines[0]?.qtyPerM3).toBe(400_000);
  });

  it('lists an order without a recette in force instead of treating its need as zero', () => {
    const r = projectStock(input({ recettes: new Map(), demands: [demand({ orderId: '1' })] }));
    expect(r.missingRecette).toEqual([{ orderCode: 'CMD-1', typeLabel: 'B25', date: '2026-11-03' }]);
    expect(projectionOf(r, 'cem').needs).toBe(0);
  });

  it('ignores an order with nothing left to load', () => {
    const r = projectStock(input({ demands: [demand({ orderId: '1', volumeL: 0 })] }));
    expect(projectionOf(r, 'cem').needs).toBe(0);
  });
});

describe('splitDemand', () => {
  it('moves part of an order to another day and leaves the rest', () => {
    const demands = [demand({ orderId: '1', date: '2026-11-05', volumeL: 6_000 })];
    const split = splitDemand(demands, '1', '2026-11-05', 3_000, '2026-11-06');
    expect(split.map((d) => [d.date, d.volumeL])).toEqual([
      ['2026-11-05', 3_000],
      ['2026-11-06', 3_000],
    ]);
    const cem = projectionOf(
      projectStock(input({ demands: split, components: [{ ...cement, level: 1_500_000 }] })),
      'cem',
    );
    expect(cem.days.map((d) => d.level)).toEqual([
      1_500_000, 1_500_000, 1_500_000, 450_000, -600_000, -600_000,
    ]);
  });

  it('leaves the list alone when the volume to move does not fit', () => {
    const demands = [demand({ orderId: '1', volumeL: 1_000 })];
    expect(splitDemand(demands, '1', '2026-11-03', 2_000, '2026-11-04')).toEqual(demands);
    expect(splitDemand(demands, '9', '2026-11-03', 500, '2026-11-04')).toEqual(demands);
  });
});

describe('draftPurchase', () => {
  const hint: SupplierHint = {
    supplierId: 's1',
    supplierCode: 'FRN-01',
    supplierName: 'Ciments du Nord',
    purchaseUnitId: 'u1',
    unitLabel: 't',
    factorToBase: 1_000_000,
    lastUnitPriceHt: centimes(95_000),
    termDays: 30,
    leadTimeDays: null,
  };
  const short = projectionOf(
    projectStock(input({ demands: [demand({ orderId: '1', volumeL: 12_000 })] })),
    'cem',
  );

  it('brings the worst level back to the threshold, rounded up, with a cost at the last price', () => {
    // level −1 200 000 → needs 1 700 000 g = 1,7 t
    const draft = draftPurchase(short, hint, '2026-11-02');
    expect(draft).toMatchObject({ qtyMilli: 1_700, qtyBase: 1_700_000, dueDate: '2026-12-02' });
    expect(draft?.estimatedHtCentimes).toBe(161_500);
  });

  it('rounds the quantity up, never down', () => {
    const odd = draftPurchase(short, { ...hint, factorToBase: 3_000_000 }, '2026-11-02');
    expect(odd?.qtyMilli).toBe(567);
    expect(odd?.qtyBase).toBeGreaterThanOrEqual(1_700_000);
  });

  it('has no cost without a last price and no date without terms', () => {
    const draft = draftPurchase(short, { ...hint, lastUnitPriceHt: null, termDays: null }, '2026-11-02');
    expect(draft).toMatchObject({ estimatedHtCentimes: null, dueDate: null });
  });

  it('is null without a supplier, or when nothing is missing', () => {
    expect(draftPurchase(short, null, '2026-11-02')).toBeNull();
    const fine = projectionOf(projectStock(input()), 'cem');
    expect(draftPurchase(fine, hint, '2026-11-02')).toBeNull();
  });
});
