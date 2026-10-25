import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { NO_HOLIDAYS } from './calendar';
import { alertKey } from './rules';
import { type EngineParams, type MoneyFacts, runEngine, type StockFacts } from './engine';

const params: EngineParams = {
  horizonDays: 7,
  threshold: centimes(0),
  leadDays: 2,
  legalReminderDays: 7,
  bounceReminderDays: [20, 27],
  clearingDelayDays: 1,
  postponeWorkingDays: 4,
  advanceExtraBp: 3_000,
  discountRateBp: 800,
  splitBp: 5_000,
  vatRateBp: 2_000,
  purchaseLeadDays: 2,
  reorderMarginDays: 2,
  calendar: NO_HOLIDAYS,
};

const money = (over: Partial<MoneyFacts> = {}): MoneyFacts => ({
  encaisse: centimes(1_000_000),
  instruments: [
    {
      id: 'in1',
      direction: 'in',
      method: 'cheque',
      amount: centimes(900_000),
      state: 'received',
      writtenDate: '2026-11-12',
      receivedDate: '2026-10-30',
      depositedOn: null,
      partyId: 'c1',
      partyName: 'CLT-01',
      label: 'CH 1',
    },
  ],
  items: [
    {
      id: 'pay1',
      direction: 'out',
      kind: 'purchase',
      documentId: 'p1',
      documentCode: 'ACH-2026-00001',
      partyId: 'f1',
      partyName: 'FRN-01',
      dueDate: '2026-11-04',
      remaining: centimes(1_500_000),
      method: 'transfer',
    },
  ],
  bounced: [],
  deadlines: [],
  ...over,
});

const stock = (level: number): StockFacts => ({
  components: [{ id: 'cem', nameFr: 'Ciment', nameAr: 'إسمنت', baseUnit: 'g', level, lowThreshold: null }],
  demands: [
    {
      orderId: 'o1',
      orderCode: 'CMD-1',
      clientCode: 'CLT-01',
      typeId: 't',
      typeLabel: 'B25',
      date: '2026-11-04',
      volumeL: 8_000,
    },
  ],
  recettes: new Map([
    ['t', [{ effectiveFrom: '2026-01-01', lines: [{ componentId: 'cem', qtyPerM3: 350_000 }] }]],
  ]),
  receipts: [],
  suppliers: new Map([
    [
      'cem',
      {
        supplierId: 'f1',
        supplierCode: 'FRN-01',
        supplierName: 'FRN-01',
        purchaseUnitId: 'u',
        unitLabel: 't',
        factorToBase: 1_000_000,
        lastUnitPriceHt: centimes(100_000),
        termDays: 30,
        leadTimeDays: null,
      },
    ],
  ]),
});

describe('runEngine', () => {
  const today = '2026-11-02';

  it('finds the black day, the day conflict and the options of both, in one deterministic run', () => {
    const r = runEngine(today, money(), stock(1_000_000), params);
    expect(r.black).toMatchObject({ date: '2026-11-04', severity: 'risk', shortfall: 500_000 });
    expect(r.lowest).toMatchObject({ date: '2026-11-04', balance: -500_000 });
    const keys = r.hits.map(alertKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'CASH-DEFICIT:2026-11-04',
        'STOCK-SHORTAGE:cem:2026-11-04',
        'DAY-CONFLICT:2026-11-04',
      ]),
    );

    const cash = r.options.get('CASH-DEFICIT:2026-11-04');
    expect(cash?.cash?.ranked[0]).toMatchObject({ id: 'DEPOSIT-EARLY:in1', full: true });
    const conflict = r.options.get('DAY-CONFLICT:2026-11-04');
    // the emergency purchase (1 800 000 g short → 1,8 t at the last price, VAT included) is part of the conflict's shortfall
    expect(conflict?.cash?.shortfall).toBe(500_000 + 216_000);
    expect(conflict?.stock.map((o) => o.kind)).toContain('EMERGENCY-PURCHASE');
    const stockAlert = r.options.get('STOCK-SHORTAGE:cem:2026-11-04');
    expect(stockAlert?.stock.length).toBeGreaterThan(0);
    expect(JSON.stringify(runEngine(today, money(), stock(1_000_000), params).hits)).toBe(
      JSON.stringify(r.hits),
    );
  });

  it('a covered day gives no deficit and no cash options', () => {
    const r = runEngine(today, money({ encaisse: centimes(5_000_000) }), stock(9_000_000), params);
    expect(r.black).toBeNull();
    expect(r.hits.map((h) => h.ruleId)).toEqual(['PAY-DUE']);
    expect(r.options.size).toBe(0);
  });

  it('without money facts only the stock rules run, and no cash figure comes out (the plant view)', () => {
    const r = runEngine(today, null, stock(1_000_000), params);
    expect(r.forecast).toEqual([]);
    expect(r.black).toBeNull();
    expect(r.hits.map((h) => h.ruleId)).toEqual(['STOCK-SHORTAGE']);
    expect(r.options.get('STOCK-SHORTAGE:cem:2026-11-04')?.stock.length).toBeGreaterThan(0);
    expect(r.encaisse).toBe(0);
  });

  it('lists the days: today then the working days of the horizon', () => {
    const r = runEngine(today, money(), stock(9_000_000), params);
    expect(r.dates).toHaveLength(8);
    expect(r.dates[0]).toBe(today);
  });

  it('runs a 60-client, 14-day dataset well under two seconds (AC-RE-12)', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      direction: (i % 3 === 0 ? 'out' : 'in') as 'in' | 'out',
      kind: (i % 3 === 0 ? 'purchase' : 'order') as 'purchase' | 'order',
      documentId: `d${i}`,
      documentCode: `DOC-${i}`,
      partyId: `party${i % 60}`,
      partyName: `P${i % 60}`,
      dueDate: `2026-11-${String(2 + (i % 14)).padStart(2, '0')}`,
      remaining: centimes(100_000 + i * 10),
      method: 'cheque',
    }));
    const start = process.hrtime.bigint();
    runEngine(today, money({ items }), stock(1_000_000), { ...params, horizonDays: 14 });
    expect(Number(process.hrtime.bigint() - start) / 1e6).toBeLessThan(2_000);
  });
});
