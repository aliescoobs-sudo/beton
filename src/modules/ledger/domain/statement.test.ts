import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import {
  buildStatement,
  type DueItem,
  type LineStatus,
  type StatementLine,
  type StatementLineType,
} from './statement';

const c = centimes;
const line = (
  id: string,
  date: string,
  type: StatementLineType,
  amount: number,
  status: LineStatus,
  counted = true,
): StatementLine => ({
  id,
  section: type === 'payment' ? 'financial' : 'commercial',
  date,
  type,
  code: id,
  status,
  amountCentimes: c(amount),
  counted,
});
const TODAY = '2026-10-24';

// A client with an opening balance, an order, a cancelled order (original + reversal), a cheque that bounced, a cheque in
// the portfolio and a cleared cash payment (AC-LED-19).
const lines: StatementLine[] = [
  line('open', '2026-08-01', 'opening', 100_000, 'booked'),
  line('o1', '2026-08-10', 'order', 1_000_000, 'booked'),
  line('o2', '2026-08-12', 'order', 500_000, 'cancelled'),
  line('o2r', '2026-08-13', 'order_cancelled', -500_000, 'booked'),
  line('p1', '2026-08-20', 'payment', -400_000, 'cleared'),
  line('p2', '2026-09-01', 'payment', -300_000, 'bounced', false),
  line('p3', '2026-10-20', 'payment', -200_000, 'received'),
];
const due: DueItem[] = [
  { dueDate: '2026-09-10', amountCentimes: c(600_000), coveredCentimes: c(400_000) },
  { dueDate: '2026-11-10', amountCentimes: c(400_000), coveredCentimes: c(200_000) },
  { dueDate: '2026-10-01', amountCentimes: c(100_000), coveredCentimes: c(100_000) },
];

describe('buildStatement', () => {
  const s = buildStatement(lines, due, TODAY);

  it('keeps the commercial and financial sections apart, with a running balance across both', () => {
    expect(s.commercial.map((r) => r.id)).toEqual(['open', 'o1', 'o2', 'o2r']);
    expect(s.financial.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    const all = [...s.commercial, ...s.financial].sort((a, b) => a.date.localeCompare(b.date));
    expect(all.map((r) => r.balanceAfter)).toEqual([
      100_000, 1_100_000, 1_600_000, 1_100_000, 700_000, 700_000, 500_000,
    ]);
    expect(s.closing).toBe(500_000);
    expect(s.carriedIn).toBe(0);
  });

  it('summarises ordered, cancelled, paid, pending, due and late', () => {
    expect(s.summary).toEqual({
      ordered: 1_000_000,
      cancelled: 500_000,
      invoiced: 0,
      paid: 400_000,
      pending: 200_000,
      due: 200_000,
      late: 200_000,
      nextDueDate: '2026-11-10',
    });
  });

  it('a bounced payment does not count: the client owes it again', () => {
    expect(buildStatement(lines, due, TODAY).closing).toBe(500_000);
    const withoutBounce = lines.filter((l) => l.id !== 'p2');
    expect(buildStatement(withoutBounce, due, TODAY).closing).toBe(500_000);
  });

  it('a date range carries in the balance before it (AC-LED-20)', () => {
    const range = buildStatement(lines, due, TODAY, { from: '2026-09-01' });
    expect(range.carriedIn).toBe(700_000);
    expect(range.financial.map((r) => r.id)).toEqual(['p2', 'p3']);
    expect(range.closing).toBe(500_000);
    expect(range.commercial).toEqual([]);
    expect(buildStatement(lines, due, TODAY, { to: '2026-08-13' }).closing).toBe(1_100_000);
  });

  it('type and status filters hide rows but never change a balance', () => {
    const f = buildStatement(lines, due, TODAY, { types: ['payment'], statuses: ['cleared', 'received'] });
    expect(f.financial.map((r) => [r.id, r.balanceAfter])).toEqual([
      ['p1', 700_000],
      ['p3', 500_000],
    ]);
    expect(f.commercial).toEqual([]);
    expect(f.closing).toBe(500_000);
  });

  it('an empty party has an empty statement', () => {
    const empty = buildStatement([], [], TODAY);
    expect(empty).toMatchObject({ commercial: [], financial: [], carriedIn: 0, closing: 0 });
    expect(empty.summary.nextDueDate).toBeNull();
  });

  it('property: the closing balance is the sum of the counted lines, whatever the filter split (AC-LED-20)', () => {
    const date = fc
      .integer({ min: 0, max: 60 })
      .map((d) => `2026-08-${String(1 + (d % 28)).padStart(2, '0')}`);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            date,
            amount: fc.integer({ min: -1_000_000, max: 1_000_000 }),
            counted: fc.boolean(),
            payment: fc.boolean(),
          }),
          { maxLength: 30 },
        ),
        date,
        (raw, split) => {
          const ls = raw.map((r, i) =>
            line(
              `l${i}`,
              r.date,
              r.payment ? 'payment' : 'order',
              r.amount,
              r.payment ? 'cleared' : 'booked',
              r.counted,
            ),
          );
          const expected = ls.filter((l) => l.counted).reduce((n, l) => n + Number(l.amountCentimes), 0);
          const whole = buildStatement(ls, [], TODAY);
          const tail = buildStatement(ls, [], TODAY, { from: split });
          return Number(whole.closing) === expected && Number(tail.closing) === expected;
        },
      ),
    );
  });
});

describe('statementToCsv', () => {
  it('writes every row with a decimal comma, French headers and the closing balance', async () => {
    const { statementToCsv } = await import('./statement-csv');
    const csv = statementToCsv(
      { code: 'CLT-001', name: 'Client; "test"' },
      buildStatement(lines, due, TODAY),
    );
    const out = csv.replace(/[\u202f\u00a0]/g, ' ').split('\r\n');
    expect(out[0]).toBe('﻿CLT-001;"Client; ""test"""');
    expect(out[1]).toBe('Date;Section;Type;Pièce;État;Montant (MAD);Solde (MAD)');
    expect(out).toContain('2026-08-20;Financier;payment;p1;cleared;-4000,00;7000,00');
    expect(out.some((l) => l.endsWith('Solde de clôture;;5000,00'))).toBe(true);
  });

  it('keeps a name that starts like a formula from running', async () => {
    const { statementToCsv } = await import('./statement-csv');
    const csv = statementToCsv({ code: 'CLT-002', name: '=HYPERLINK("x")' }, buildStatement([], [], TODAY));
    expect(csv.split('\r\n')[0]).toContain("'=HYPERLINK");
  });
});

describe('invoices in a statement (AC-LED-19)', () => {
  const withInvoices: StatementLine[] = [
    line('o1', '2026-08-10', 'order', 1_000_000, 'booked'),
    line('f1', '2026-08-31', 'invoice', 1_000_000, 'cancelled', false),
    line('a1', '2026-09-02', 'credit_note', -1_000_000, 'booked', false),
    line('f2', '2026-09-03', 'invoice', 600_000, 'booked', false),
  ];
  const s = buildStatement(withInvoices, [], TODAY);
  it('are documents on top of the order: listed in the commercial section, never added to the balance', () => {
    expect(s.commercial.map((r) => r.id)).toEqual(['o1', 'f1', 'a1', 'f2']);
    expect(s.commercial.map((r) => r.balanceAfter)).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000]);
    expect(s.closing).toBe(1_000_000);
  });
  it('the summary shows what was invoiced, net of credit notes', () => {
    expect(s.summary.invoiced).toBe(600_000);
  });
});
