import { describe, expect, it } from 'vitest';
import { buildForecast, type ForecastItem } from './cash-forecast';

const it_ = (kind: ForecastItem['kind'], due: string, amount: number, label = 'x'): ForecastItem => ({
  kind,
  side: kind === 'client_cheque' ? 'in' : 'out',
  label,
  party: null,
  dueDate: due,
  amountCentimes: amount,
});

describe('buildForecast (the arithmetic twin of the forecast screen)', () => {
  const today = '2026-12-15';
  it('horizons are cumulative from today, the boundary days belong to the nearer horizon, past items are overdue, beyond 90 days is left out', () => {
    const f = buildForecast(
      [
        it_('client_cheque', '2026-12-14', 1), // overdue
        it_('client_cheque', '2026-12-15', 10), // today: 30
        it_('client_cheque', '2027-01-14', 100), // +30: 30
        it_('client_cheque', '2027-01-15', 1_000), // +31: 60
        it_('client_cheque', '2027-02-13', 10_000), // +60: 60
        it_('client_cheque', '2027-02-14', 100_000), // +61: 90
        it_('client_cheque', '2027-03-15', 1_000_000), // +90: 90
        it_('client_cheque', '2027-03-16', 9_999_999), // +91: out
      ],
      today,
    );
    expect(f.incoming).toEqual({ overdue: 1, d30: 110, d60: 11_110, d90: 1_111_110 });
    expect(f.items).toHaveLength(7);
    expect(f.outgoing).toEqual({ overdue: 0, d30: 0, d60: 0, d90: 0 });
  });
  it('out sums issued cheques and instalments; net is in minus out in every column; kinds add up to their side', () => {
    const f = buildForecast(
      [
        it_('client_cheque', '2026-12-20', 5_000),
        it_('issued_cheque', '2026-12-21', 1_200),
        it_('instalment', '2027-01-05', 800),
        it_('instalment', '2027-02-05', 800),
        it_('issued_cheque', '2026-12-01', 50), // overdue out
      ],
      today,
    );
    expect(f.outgoing).toEqual({ overdue: 50, d30: 2_000, d60: 2_800, d90: 2_800 });
    expect(f.net).toEqual({ overdue: -50, d30: 3_000, d60: 2_200, d90: 2_200 });
    for (const col of ['overdue', 'd30', 'd60', 'd90'] as const) {
      expect(f.byKind.issued_cheque[col] + f.byKind.instalment[col]).toBe(f.outgoing[col]);
      expect(f.byKind.client_cheque[col]).toBe(f.incoming[col]);
      expect(f.incoming[col] - f.outgoing[col]).toBe(f.net[col]);
    }
  });
  it('ignores a zero or negative amount and sorts the items by due date', () => {
    const f = buildForecast(
      [
        it_('instalment', '2027-01-02', 0),
        it_('instalment', '2027-01-03', 5, 'b'),
        it_('instalment', '2026-12-30', 7, 'a'),
      ],
      today,
    );
    expect(f.items.map((i) => i.label)).toEqual(['a', 'b']);
  });
});
