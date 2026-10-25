import { describe, expect, it } from 'vitest';
import {
  ageingBucket,
  ageingCsv,
  paymentsCsv,
  purchasesJournalCsv,
  reconcile,
  type SalesRow,
  salesJournalCsv,
} from './journals';

const sale = (over: Partial<SalesRow> = {}): SalesRow => ({
  number: 'FA-2026-00001',
  date: '2026-06-10',
  clientName: 'Atlas BTP (fictif)',
  clientIce: '001234567000089',
  htCentimes: 780_000,
  vatCentimes: 156_000,
  ttcCentimes: 936_000,
  creditNoteOf: null,
  ...over,
});

describe('journals as CSV', () => {
  it('the sales journal has a decimal comma, a total line and a credit note negated', () => {
    const csv = salesJournalCsv([
      sale(),
      sale({
        number: 'FA-2026-00002',
        htCentimes: -780_000,
        vatCentimes: -156_000,
        ttcCentimes: -936_000,
        creditNoteOf: 'FA-2026-00001',
      }),
    ]);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('Pièce;Date;Client;ICE;Total HT (MAD);TVA (MAD);Total TTC (MAD);Avoir de');
    expect(lines[1]).toBe(
      'FA-2026-00001;2026-06-10;Atlas BTP (fictif);001234567000089;7800,00;1560,00;9360,00;',
    );
    expect(lines[2]).toContain('-7800,00');
    expect(lines[3]).toBe('Total;;;;0,00;0,00;0,00;');
  });
  it('neutralises a name that a spreadsheet could take for a formula', () => {
    const csv = salesJournalCsv([sale({ clientName: '=HYPERLINK("http://x")' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
  it('purchases and payments carry their totals', () => {
    expect(
      purchasesJournalCsv([
        {
          code: 'ACH-2026-00001',
          date: '2026-06-01',
          supplierName: 'Ciments du Nord',
          supplierInvoiceNo: 'F1',
          dueDate: '2026-07-30',
          htCentimes: 4_350_000,
          vatCentimes: 870_000,
          ttcCentimes: 5_220_000,
        },
      ]),
    ).toContain('Total;;;;;43500,00;8700,00;52200,00');
    const csv = paymentsCsv(
      [
        {
          date: '2026-06-02',
          direction: 'in',
          method: 'cheque',
          number: 'C1',
          partyName: 'Atlas',
          amountCentimes: 100_000,
          state: 'cleared',
        },
      ],
      [{ date: '2026-06-03', account: 'Banque', source: 'instrument', amountCentimes: 100_000 }],
    );
    expect(csv).toContain('Encaissement;cheque;C1;Atlas;1000,00;cleared');
    expect(csv).toContain('Total;;;1000,00');
  });
});

describe('ageing', () => {
  it.each([
    ['2026-07-01', 'not_due'],
    ['2026-06-30', 'not_due'],
    ['2026-06-29', 'd0_30'],
    ['2026-05-31', 'd0_30'],
    ['2026-05-30', 'd31_60'],
    ['2026-04-01', 'd61_90'],
    ['2026-03-01', 'over_90'],
  ] as const)('due %s on 2026-06-30 is %s', (due, bucket) => {
    expect(ageingBucket(due, '2026-06-30')).toBe(bucket);
  });
  it('totals per bucket and in all', () => {
    const csv = ageingCsv(
      '2026-06-30',
      [
        { party: 'A', document: 'FA-1', dueDate: '2026-06-20', openCentimes: 100_000 },
        { party: 'B', document: 'FA-2', dueDate: '2026-07-20', openCentimes: 50_000 },
      ],
      [],
    );
    expect(csv).toContain('Total 1 à 30 jours;1000,00');
    expect(csv).toContain('Total Non échu;500,00');
    expect(csv).toContain(';;Total;1500,00;');
  });
});

describe('reconcile (AC-LED-24)', () => {
  it('passes when every row adds up and the journal equals the invoice lines', () => {
    expect(reconcile({ sales: [sale()], purchases: [], invoiceLinesHtCentimes: 780_000 })).toEqual({
      ok: true,
      value: true,
    });
  });
  it('refuses a row whose HT + VAT is not the TTC, and a journal that is not the lines', () => {
    expect(
      reconcile({ sales: [sale({ ttcCentimes: 1 })], purchases: [], invoiceLinesHtCentimes: 780_000 }),
    ).toEqual({ ok: false, error: 'TOTALS_DO_NOT_ADD_UP' });
    expect(reconcile({ sales: [sale()], purchases: [], invoiceLinesHtCentimes: 779_999 })).toEqual({
      ok: false,
      error: 'LINES_DO_NOT_MATCH_INVOICES',
    });
  });
});
