import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate, scale, sum } from './money';
import { addMonths, periodRange, validDate } from './period';
import { managementReport } from './report';
import {
  canonicalFlows,
  cashForecast,
  steelFlows,
  suggestSteel,
  rankSteelOptions,
  type CashFlow,
} from './forecast';
import { canFinance } from './permissions';
const flow = (id: string, date: string, direction: 'in' | 'out', amountCentimes: number): CashFlow => ({
  id,
  commitmentId: id,
  date,
  direction,
  amountCentimes,
  source: 'schedule',
});
describe('finance periods and exact integer money', () => {
  it('all four report periods, leap year and invalid values', () => {
    expect(periodRange(2028, 'month', 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange(2026, 'quarter', 4)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodRange(2026, 'half', 2)).toEqual({ from: '2026-07-01', to: '2026-12-31' });
    expect(periodRange(2026, 'year', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(() => periodRange(2026, 'quarter', 5)).toThrow();
    expect(validDate('2026-02-30')).toBe(false);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
  it('rounds consumption once; handles large intermediate products without floating point', () => {
    expect(scale(9000000000000, 300000000, 900000000)).toBe(3000000000000);
    expect(scale(-1, 1, 2)).toBe(-1);
    expect(scale(1, 1, 2)).toBe(1);
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow('UNSAFE_INTEGER');
  });
  it('allocations conserve every centime including reversals (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000000, max: 10000000 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 0, max: 10000 }),
        (amount, a, b) => {
          const result = allocate(amount, { A: a, B: b });
          expect(sum(Object.values(result))).toBe(amount);
        },
      ),
      { numRuns: 400 },
    );
    expect(allocate(1, { B: 1, A: 1 })).toEqual({ A: 1, B: 0 });
    expect(() => allocate(1, { A: 0 })).toThrow();
  });
});
describe('plant results, central charges, total; consumption, principal and explicit leasing', () => {
  it('consumption and shared pump expense are counted once; central finance remains central', () => {
    const r = managementReport({
      from: '2026-01-01',
      to: '2026-01-31',
      plants: [
        { id: 'A', name: 'Tétouan' },
        { id: 'B', name: 'Chefchaouen' },
      ],
      leasingTreatment: 'expense',
      facts: [
        { id: 'a', date: '2026-01-01', plantId: 'A', kind: 'concrete', amountCentimes: 10000 },
        { id: 'b', date: '2026-01-01', plantId: 'B', kind: 'pumping', amountCentimes: 5000 },
        { id: 'm', date: '2026-01-01', plantId: 'A', kind: 'material', amountCentimes: 2000 },
        {
          id: 'pump',
          date: '2026-01-01',
          plantId: null,
          allocation: { A: 1, B: 1 },
          kind: 'expense',
          amountCentimes: 1001,
        },
        { id: 'principal', date: '2026-01-01', plantId: null, kind: 'principal', amountCentimes: 8000 },
        { id: 'interest', date: '2026-01-01', plantId: 'A', kind: 'financing', amountCentimes: 200 },
        { id: 'steel', date: '2026-01-01', plantId: null, kind: 'steel_cost', amountCentimes: 500 },
      ],
    });
    expect(r.title).toBe('Résultat de gestion (données enregistrées)');
    expect(r.plants.map((p) => p.resultCentimes)).toEqual([7499, 4500]);
    expect(r.central.resultCentimes).toBe(-700);
    expect(r.total.resultCentimes).toBe(11299);
    expect(r.total.principalCentimes).toBe(8000);
  });
  it('missing valuation and unconfirmed prices make the report visibly incomplete', () => {
    expect(
      managementReport({
        from: '2026-01-01',
        to: '2026-12-31',
        plants: [],
        facts: [],
        leasingTreatment: 'expense',
        missingValuations: 1,
        excludedRevenueCentimes: 200,
      }).complete,
    ).toBe(false);
  });
  it('unconfirmed documents stay visible as a count even when signed credits net to zero', () => {
    const r = managementReport({
      from: '2026-01-01',
      to: '2026-12-31',
      plants: [],
      facts: [],
      leasingTreatment: 'expense',
      excludedRevenueCentimes: 0,
      excludedRevenueCount: 2,
    });
    expect(r.excludedRevenueCentimes).toBe(0);
    expect(r.excludedRevenueCount).toBe(2);
    expect(r.complete).toBe(false);
  });
  it('leasing principal is an explicit policy; interest is separately central', () => {
    const input = {
      from: '2026-01-01',
      to: '2026-12-31',
      plants: [],
      facts: [{ id: 'l', date: '2026-01-01', plantId: null, kind: 'leasing' as const, amountCentimes: 100 }],
    };
    expect(managementReport({ ...input, leasingTreatment: 'expense' }).total.costsCentimes).toBe(100);
    expect(
      managementReport({ ...input, leasingTreatment: 'principal_interest' }).total.principalCentimes,
    ).toBe(100);
  });
});
describe('cash commitments: no double counting', () => {
  it('a partial cheque replaces only the covered portion of an installment', () => {
    const installment = flow('loan', '2026-12-01', 'out', 1000);
    const cheque: CashFlow = {
      ...flow('cheque', '2026-12-10', 'out', 400),
      commitmentId: 'loan',
      source: 'instrument',
    };
    expect(
      canonicalFlows([installment, cheque])
        .map((f) => f.amountCentimes)
        .sort(),
    ).toEqual([400, 600]);
    expect(cashForecast(1000, '2026-12-01', '2026-12-31', [installment, cheque]).minimumCentimes).toBe(0);
    expect(() => canonicalFlows([installment, { ...cheque, amountCentimes: 1001 }])).toThrow('OVER_COVERED');
  });
  it('overdue outflows remain due and issued cheques can be presented early', () => {
    const c = {
      ...flow('c', '2026-12-20', 'out', 100),
      source: 'instrument' as const,
      method: 'cheque',
      issuedDate: '2026-11-10',
    };
    const r = cashForecast(50, '2026-11-15', '2026-12-25', [c], true);
    expect(r.days[0]!.balanceCentimes).toBe(-50);
    expect(cashForecast(50, '2026-11-15', '2026-12-25', [c]).days[0]!.balanceCentimes).toBe(50);
  });
  it('rejects duplicate IDs, contradictory directions, invalid horizons and unsafe amounts', () => {
    const f = flow('x', '2026-11-01', 'out', 100);
    expect(() => canonicalFlows([f, f])).toThrow('DUPLICATE');
    expect(() => cashForecast(0, 'invalid', '2026-12-01', [])).toThrow();
    expect(() => canonicalFlows([{ ...f, amountCentimes: 0 }])).toThrow();
  });
});
describe('steel: cash now and complete cheque tail', () => {
  const terms = { deliveryDate: '2026-11-02', cashCentimes: 900, purchaseCentimes: 1000, chequeCount: 3 };
  it('cash on delivery, cheques month 1, 2, 3; no shipment into material inventory', () => {
    const flows = steelFlows(terms);
    expect(flows[0]!.date).toBe('2026-11-02');
    expect(flows[0]!.direction).toBe('in');
    expect(flows.slice(1).map((f) => f.date)).toEqual(['2026-12-02', '2027-01-02', '2027-02-02']);
    expect(sum(flows.slice(1).map((f) => f.amountCentimes))).toBe(1000);
  });
  it('refuses the apparent rescue when the repayment creates a larger later gap', () => {
    const base = [flow('expense', '2026-11-03', 'out', 100)];
    const r = suggestSteel(0, '2026-11-02', '2026-11-30', base, [terms], 50);
    expect(r.horizonTo).toBe('2027-02-02');
    expect(r.baseline.minimumCentimes).toBe(-100);
    expect(r.scenario.minimumCentimes).toBe(-200);
    expect(r.suggested).toBe(false);
    expect(r.costCentimes).toBe(100);
  });
  it('accepts a deal only when real later collections cover its cheque tail; compares bank cost', () => {
    const base = [flow('expense', '2026-11-03', 'out', 500), flow('collection', '2026-11-30', 'in', 1100)];
    const r = suggestSteel(0, '2026-11-02', '2026-11-30', base, [terms], 50);
    expect(r.suggested).toBe(true);
    expect(r.scenario.minimumCentimes).toBeGreaterThanOrEqual(0);
    expect(r.differenceToBankCentimes).toBe(50);
    expect(suggestSteel(0, '2026-11-02', '2026-11-30', base, [terms, terms], 50).costCentimes).toBe(200);
  });
  it('tries one or more deals, covers the original gap and ranks by total cost', () => {
    const base = [flow('need', '2026-11-03', 'out', 1500), flow('collection', '2026-11-30', 'in', 3000)];
    const options = rankSteelOptions(0, '2026-11-02', '2027-02-02', base, terms, 3, 50);
    expect(options[0]?.dealCount).toBe(2);
    expect(options[0]?.initialGapCovered).toBe(true);
    expect(suggestSteel(0, '2026-11-02', '2027-02-02', base, [terms], 50).suggested).toBe(false);
  });
  it('rejects simulated cash in the past and an invalid steel sale', () => {
    expect(() => steelFlows({ ...terms, cashCentimes: 1100 })).toThrow();
    expect(() => suggestSteel(0, '2026-11-03', '2026-12-01', [], [terms], 0)).toThrow();
  });
});
describe('finance visibility is independent of document entry or print', () => {
  for (const role of [
    'office',
    'office_sales',
    'office_purchases',
    'partner',
    'plant',
    'plant_manager',
    'support',
    'accountant',
    'driver',
    'pump_operator',
    'client_portal',
    'supplier_portal',
    'anonymous',
  ]) {
    it(`${role} cannot read management finance`, () => {
      expect(canFinance(role, 'finance.read')).toBe(false);
      expect(canFinance(role, 'finance.write')).toBe(false);
    });
  }
  it('accountant exports only; owner and app_admin read/write', () => {
    expect(canFinance('accountant', 'finance.export')).toBe(true);
    expect(canFinance('office_sales', 'finance.export')).toBe(false);
    for (const r of ['owner', 'app_admin']) expect(canFinance(r, 'finance.write')).toBe(true);
  });
});
