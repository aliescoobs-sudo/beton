import { describe, expect, it } from 'vitest';
import { parseSupplierInvoiceInput } from './supplier-invoice';

const base = {
  purchaseCode: 'ach-2026-00012',
  supplierInvoiceNo: '  F-2026/118  ',
  invoiceDate: '2026-06-02',
  lines: [
    { componentId: '0192a000-0000-7000-8000-000000000001', qtyMilli: 30_000, unitPriceHtCentimes: 145_000 },
  ],
};

describe('parseSupplierInvoiceInput (AC-INT-13)', () => {
  it('normalises the order code and the supplier number, and keeps the lines in thousandths', () => {
    const r = parseSupplierInvoiceInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.purchaseCode).toBe('ACH-2026-00012');
      expect(r.value.supplierInvoiceNo).toBe('F-2026/118');
      expect(r.value.lines[0]).toMatchObject({ qtyMilli: 30_000, unitPriceHtCentimes: 145_000 });
    }
  });

  it('accepts a service line described in words, a due date and named receipts', () => {
    const r = parseSupplierInvoiceInput({
      ...base,
      dueDate: '2026-08-01',
      receiptIds: ['0192a000-0000-7000-8000-000000000002'],
      lines: [{ description: 'Transport', qtyMilli: 1000, unitPriceHtCentimes: 50_000 }],
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['not an order code', { purchaseCode: 'CMD-2026-00001' }],
    ['no supplier number', { supplierInvoiceNo: '   ' }],
    ['a date that does not exist', { invoiceDate: '2026-02-30' }],
    ['no line', { lines: [] }],
    ['a line with neither component nor words', { lines: [{ qtyMilli: 1000, unitPriceHtCentimes: 100 }] }],
    ['a quantity of zero', { lines: [{ description: 'x', qtyMilli: 0, unitPriceHtCentimes: 100 }] }],
    ['a price with decimals', { lines: [{ description: 'x', qtyMilli: 1000, unitPriceHtCentimes: 10.5 }] }],
    ['a receipt that is not an id', { receiptIds: ['nope'] }],
  ])('refuses %s', (_name, patch) => {
    expect(parseSupplierInvoiceInput({ ...base, ...patch }).ok).toBe(false);
  });
});
