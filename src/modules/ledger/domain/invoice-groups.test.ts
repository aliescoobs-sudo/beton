import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { groupInvoiceLines, netToPay } from './invoice-groups';

const line = (blNo: string, typeCode: string, price: number, volumeL: number, ht: number) => ({
  blNo,
  typeCode,
  typeLabel: `Béton ${typeCode}`,
  unitPriceHtCentimes: price,
  volumeL,
  lineHtCentimes: ht,
});

describe('groupInvoiceLines (AC-INT-06)', () => {
  it('sums the quantity per product and lists the BL numbers', () => {
    const g = groupInvoiceLines([
      line('BL-1', 'B25', 78_000, 8000, 624_000),
      line('BL-2', 'B20', 70_000, 2000, 140_000),
      line('BL-3', 'B25', 78_000, 4000, 312_000),
    ]);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({
      typeCode: 'B20',
      volumeL: 2000,
      amountHtCentimes: 140_000,
      blNos: ['BL-2'],
    });
    expect(g[1]).toMatchObject({
      typeCode: 'B25',
      volumeL: 12_000,
      amountHtCentimes: 936_000,
      blNos: ['BL-1', 'BL-3'],
    });
  });

  it('the same product at two prices stays two lines', () => {
    const g = groupInvoiceLines([
      line('BL-1', 'B25', 78_000, 1000, 78_000),
      line('BL-2', 'B25', 80_000, 1000, 80_000),
    ]);
    expect(g.map((x) => x.unitPriceHtCentimes)).toEqual([78_000, 80_000]);
  });

  it('a credit note groups its negative lines the same way', () => {
    const g = groupInvoiceLines([
      line('BL-1', 'B25', 78_000, -8000, -624_000),
      line('BL-3', 'B25', 78_000, -4000, -312_000),
    ]);
    expect(g[0]).toMatchObject({ volumeL: -12_000, amountHtCentimes: -936_000 });
  });

  it('the groups add up to the stored lines whatever the rounding (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom('B20', 'B25', 'B30'),
            price: fc.constantFrom(70_000, 78_050, 80_000),
            volume: fc.integer({ min: 1, max: 12_000 }),
            ht: fc.integer({ min: 1, max: 2_000_000 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (rows) => {
          const lines = rows.map((r, i) => line(`BL-${i}`, r.type, r.price, r.volume, r.ht));
          const groups = groupInvoiceLines(lines);
          expect(groups.reduce((s, g) => s + g.amountHtCentimes, 0)).toBe(rows.reduce((s, r) => s + r.ht, 0));
          expect(groups.reduce((s, g) => s + g.volumeL, 0)).toBe(rows.reduce((s, r) => s + r.volume, 0));
          expect(groups.flatMap((g) => g.blNos).sort()).toEqual(lines.map((l) => l.blNo).sort());
        },
      ),
    );
  });
});

describe('netToPay (AC-INT-07)', () => {
  it('is the total minus the advance, never below zero', () => {
    expect(netToPay(936_000 + 187_200, 337_000)).toBe(786_200);
    expect(netToPay(1_000, 1_000)).toBe(0);
    expect(netToPay(1_000, 5_000)).toBe(0);
  });
});
