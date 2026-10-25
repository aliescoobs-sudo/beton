import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { amountBy, type PricedLoad, type SoldLoad, volumeBy } from './volume-analytics';

const load = (over: Partial<PricedLoad>): PricedLoad => ({
  date: '2026-11-02',
  clientId: 'c1',
  clientCode: 'CLT-001',
  typeId: 't1',
  typeLabel: 'B25',
  zoneId: 'z1',
  zoneName: 'Tetouan',
  volumeL: 8000,
  unitPriceHtCentimes: centimes(78_000),
  ...over,
});

describe('volume analytics (AC-OPS-24)', () => {
  const loads = [
    load({}),
    load({ volumeL: 4000, clientId: 'c2', clientCode: 'CLT-002' }),
    load({ date: '2026-11-03', typeId: 't2', typeLabel: 'B20', volumeL: 6000, zoneId: null, zoneName: null }),
    load({ date: '2026-11-10', volumeL: 8000 }),
    // a cancellation of the first load
    load({ volumeL: -8000 }),
  ];

  it('m³ per day, week and month per client, type and zone, cancellations netted', () => {
    expect(volumeBy(loads, 'day', 'type').map((r) => [r.period, r.label, r.volumeL])).toEqual([
      ['2026-11-02', 'B25', 4000],
      ['2026-11-03', 'B20', 6000],
      ['2026-11-10', 'B25', 8000],
    ]);
    expect(volumeBy(loads, 'week', 'client').map((r) => [r.period, r.label, r.volumeL])).toEqual([
      ['2026-W45', 'CLT-001', 6000],
      ['2026-W45', 'CLT-002', 4000],
      ['2026-W46', 'CLT-001', 8000],
    ]);
    expect(volumeBy(loads, 'month', 'zone').map((r) => [r.label, r.volumeL])).toEqual([
      ['Tetouan', 12000],
      ['—', 6000],
    ]);
  });

  it('the quantity side has no money field', () => {
    expect(Object.keys(volumeBy(loads, 'day', 'client')[0] ?? {}).join(' ')).not.toMatch(
      /amount|price|centimes/i,
    );
  });

  it('the amount side is the volume at the order price, one rounding per load: 8 m³ × 780,00 = 6 240,00', () => {
    const [row] = amountBy([load({})], 'day', 'client');
    expect(row?.amountHtCentimes).toBe(624_000);
    // 3,333 m³ × 780,00 = 2 599,74 (rounded once)
    expect(amountBy([load({ volumeL: 3333 })], 'day', 'client')[0]?.amountHtCentimes).toBe(259_974);
  });

  it('a cancellation takes its amount back', () => {
    const net = amountBy([load({}), load({ volumeL: -8000 })], 'day', 'client')[0];
    expect(net).toMatchObject({ volumeL: 0, amountHtCentimes: 0 });
  });

  it('property: the sum over rows equals the sum over loads, for every period and dimension', () => {
    const arb = fc.record({
      date: fc
        .integer({ min: 0, max: 80 })
        .map((n) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10)),
      clientId: fc.constantFrom('a', 'b'),
      clientCode: fc.constant('C'),
      typeId: fc.constantFrom('x', 'y'),
      typeLabel: fc.constant('T'),
      zoneId: fc.constantFrom('z', null),
      zoneName: fc.constant('Z'),
      volumeL: fc.integer({ min: -9000, max: 9000 }),
      unitPriceHtCentimes: fc.integer({ min: 1000, max: 200_000 }).map(centimes),
    });
    fc.assert(
      fc.property(fc.array(arb, { maxLength: 40 }), (ls: PricedLoad[]) => {
        const litres = ls.reduce((s, l) => s + l.volumeL, 0);
        const sold: SoldLoad[] = ls;
        for (const p of ['day', 'week', 'month'] as const)
          for (const d of ['client', 'type', 'zone'] as const) {
            expect(volumeBy(sold, p, d).reduce((s, r) => s + r.volumeL, 0)).toBe(litres);
            expect(amountBy(ls, p, d).reduce((s, r) => s + r.volumeL, 0)).toBe(litres);
          }
      }),
    );
  });
});
