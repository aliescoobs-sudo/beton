import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { fuelCosts, type FuelFill, fuelPrice, fuelQuantities } from './fuel';

const fill = (truckId: string, date: string, litres: number, odometerKm: number | null): FuelFill => ({
  truckId,
  date,
  litresMl: litres * 1000,
  odometerKm,
});

describe('fuel quantities (AC-OPS-22)', () => {
  const fills = [
    fill('t1', '2026-11-02', 200, 100_000),
    fill('t1', '2026-11-09', 180, 100_500),
    fill('t1', '2026-11-16', 220, 101_000),
    fill('t2', '2026-11-03', 150, null),
  ];
  const volumes = [
    { truckId: 't1', volumeL: 80_000 },
    { truckId: 't1', volumeL: -8_000 },
    { truckId: 't2', volumeL: 0 },
  ];
  const q = fuelQuantities(fills, volumes);
  const t1 = q.find((x) => x.truckId === 't1');
  const t2 = q.find((x) => x.truckId === 't2');

  it('litres, km between the first and last odometer, fuel burnt over that distance, per 100 km', () => {
    expect(t1).toMatchObject({ fills: 3, litresMl: 600_000, km: 1000, litresMlOverKm: 400_000 });
    // 400 L over 1 000 km = 40 L per 100 km
    expect(t1?.mlPer100Km).toBe(40_000);
  });
  it('litres per m³ delivered, cancellations netted', () => {
    // 600 L over 72 m³ = 8,33 L per m³
    expect(t1?.deliveredL).toBe(72_000);
    expect(t1?.mlPerM3).toBe(8333);
  });
  it('fewer than two odometer readings: no km, nothing invented; nothing delivered: no litres per m³', () => {
    expect(t2).toMatchObject({ km: null, mlPer100Km: null, mlPerM3: null, litresMl: 150_000 });
  });
  it('carries no money field at all', () => {
    expect(Object.keys(t1 ?? {}).join(' ')).not.toMatch(/cost|price|centimes|amount/i);
  });
});

describe('fuel money (AC-OPS-22)', () => {
  const purchases = [
    { litresMl: 1_000_000, totalCentimes: centimes(1_200_000) }, // 1000 L at 12,00 MAD
    { litresMl: 500_000, totalCentimes: centimes(630_000) }, // 500 L at 12,60 MAD
  ];
  it('the average price is Σ amount ÷ Σ litres: 1 830 000 / 1 500 L = 12,20 MAD per litre', () => {
    const p = fuelPrice(purchases);
    expect(p).toMatchObject({ totalCentimes: 1_830_000, litresMl: 1_500_000, centimesPerLitre: 1220 });
  });
  it('a truck costs its litres at that price, and the cost per m³ follows', () => {
    const q = fuelQuantities([fill('t1', '2026-11-02', 600, null)], [{ truckId: 't1', volumeL: 72_000 }]);
    const [c] = fuelCosts(q, fuelPrice(purchases));
    // 600 L × 12,20 = 7 320,00 MAD; per m³ 7 320 / 72 = 101,67
    expect(c).toEqual({ truckId: 't1', costCentimes: 732_000, costPerM3Centimes: 10_167 });
  });
  it('no purchase, no price, no cost: null, never zero', () => {
    const q = fuelQuantities([fill('t1', '2026-11-02', 600, null)], [{ truckId: 't1', volumeL: 72_000 }]);
    expect(fuelCosts(q, fuelPrice([]))[0]).toEqual({
      truckId: 't1',
      costCentimes: null,
      costPerM3Centimes: null,
    });
  });
  it('property: each cost is the exact ratio rounded once, and the costs add up to the purchases within one centime per truck', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 900_000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1_000, max: 50_000_000 }),
        (litresPerTruck, total) => {
          const fills = litresPerTruck.map((l, i) => ({
            truckId: `t${i}`,
            date: '2026-11-02',
            litresMl: l,
            odometerKm: null,
          }));
          const litres = litresPerTruck.reduce((s, l) => s + l, 0);
          const price = fuelPrice([{ litresMl: litres, totalCentimes: centimes(total) }]);
          const costs = fuelCosts(fuelQuantities(fills, []), price);
          const sum = costs.reduce((s, c) => s + (c.costCentimes as number), 0);
          expect(Math.abs(sum - total)).toBeLessThanOrEqual(costs.length);
          for (const [i, c] of costs.entries()) {
            const n = BigInt(total) * BigInt(litresPerTruck[i] as number);
            const d = BigInt(litres);
            const q = n / d;
            const away = (n % d) * 2n >= d;
            expect(c.costCentimes).toBe(Number(away ? q + 1n : q));
          }
        },
      ),
    );
  });
});
