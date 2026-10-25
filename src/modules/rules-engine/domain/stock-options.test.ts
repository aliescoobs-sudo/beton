import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import { generateStockOptions, type StockOptionParams } from './stock-options';
import { projectStock, type StockRiskInput, type SupplierHint } from './stock-risk';

const params: StockOptionParams = {
  today: '2026-11-02',
  calendar: NO_HOLIDAYS,
  splitBp: 5_000,
  vatRateBp: 2_000,
  purchaseLeadDays: 2,
};

const hint: SupplierHint = {
  supplierId: 's1',
  supplierCode: 'FRN-01',
  supplierName: 'Ciments du Nord',
  purchaseUnitId: 'u1',
  unitLabel: 't',
  factorToBase: 1_000_000,
  lastUnitPriceHt: centimes(100_000),
  termDays: 30,
};

const input = (level: number, demands: StockRiskInput['demands']): StockRiskInput => ({
  today: '2026-11-02',
  horizonDays: 5,
  calendar: NO_HOLIDAYS,
  components: [{ id: 'cem', nameFr: 'Ciment', nameAr: 'إسمنت', baseUnit: 'g', level, lowThreshold: null }],
  demands,
  recettes: new Map([
    ['t', [{ effectiveFrom: '2026-01-01', lines: [{ componentId: 'cem', qtyPerM3: 350_000 }] }]],
  ]),
  receipts: [],
});

const d = (orderId: string, date: string, volumeL: number) => ({
  orderId,
  orderCode: `CMD-${orderId}`,
  clientCode: `CLT-${orderId}`,
  typeId: 't',
  typeLabel: 'B25',
  date,
  volumeL,
});

describe('generateStockOptions', () => {
  // 3 000 000 g; two orders on the 4th: 8 m³ (2 800 000 g) and 4 m³ (1 400 000 g) → −1 200 000 g
  const stock = input(3_000_000, [d('1', '2026-11-04', 8_000), d('2', '2026-11-04', 4_000)]);
  const projection = projectStock(stock).components[0];

  it('offers an emergency purchase at the last price, VAT in the cash estimate, and says if it is in time', () => {
    if (!projection) throw new Error('no projection');
    const [first] = generateStockOptions(stock, projection, hint, params).filter(
      (o) => o.kind === 'EMERGENCY-PURCHASE',
    );
    expect(first).toMatchObject({ coverageBp: 10_000, inTime: true, arrivesOn: '2026-11-04' });
    // 1,2 t at 1 000,00 HT = 1 200,00 HT; + 20 % = 1 440,00
    expect(first?.draft?.qtyMilli).toBe(1_200);
    expect(first?.cashImpact).toBe(144_000);
  });

  it('says the purchase is late when the goods would arrive after the shortage', () => {
    if (!projection) throw new Error('no projection');
    const late = generateStockOptions(stock, projection, hint, { ...params, purchaseLeadDays: 5 }).find(
      (o) => o.kind === 'EMERGENCY-PURCHASE',
    );
    expect(late?.inTime).toBe(false);
  });

  it('offers to split the biggest orders of the day and measures what it removes and where the shortage goes', () => {
    if (!projection) throw new Error('no projection');
    const splits = generateStockOptions(stock, projection, hint, params).filter(
      (o) => o.kind === 'SPLIT-DELIVERY',
    );
    expect(splits.map((s) => s.split?.orderCode)).toEqual(['CMD-1', 'CMD-2']);
    // half of the 8 m³ order (1 400 000 g) goes to the 5th: the shortage on the 4th is 1 200 000 → covered, but the 5th is short by 200 000
    expect(splits[0]).toMatchObject({ coverageBp: 10_000 });
    expect(splits[0]?.split).toMatchObject({
      movedL: 4_000,
      toDate: '2026-11-05',
      shortageAfter: '2026-11-05',
    });
    expect(splits[1]?.split?.movedL).toBe(2_000);
    expect(splits[1]?.coverageBp).toBe(5_833);
  });

  it('has no purchase option without a supplier, and nothing at all without a shortage', () => {
    if (!projection) throw new Error('no projection');
    expect(
      generateStockOptions(stock, projection, null, params).some((o) => o.kind === 'EMERGENCY-PURCHASE'),
    ).toBe(false);
    const fine = input(10_000_000, [d('1', '2026-11-04', 8_000)]);
    expect(generateStockOptions(fine, projectStock(fine).components[0] as never, hint, params)).toEqual([]);
  });

  it('is deterministic', () => {
    if (!projection) throw new Error('no projection');
    expect(JSON.stringify(generateStockOptions(stock, projection, hint, params))).toBe(
      JSON.stringify(generateStockOptions(stock, projection, hint, params)),
    );
  });
});
