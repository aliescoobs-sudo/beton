import { type CsvCell, num, toCsv } from '@/lib/csv';
import { err, ok, type Result } from '@/lib/result';
import { daysBetween } from './reversal';
import { plainAmount } from './statement-csv';

// The accountant's files (ledger L32, SPEC-ledger): sales journal, purchases journal, payments and bank/cash movements,
// receivables and payables ageing. Pure: the service reads the rows, this arranges them as CSV and checks they tie out.

export interface SalesRow {
  number: string;
  date: string;
  clientName: string;
  clientIce: string | null;
  htCentimes: number;
  vatCentimes: number;
  ttcCentimes: number;
  /** The invoice a credit note cancels, else null. */
  creditNoteOf: string | null;
}
export interface PurchaseRow {
  code: string;
  date: string;
  supplierName: string;
  supplierInvoiceNo: string | null;
  dueDate: string;
  htCentimes: number;
  vatCentimes: number;
  ttcCentimes: number;
}
export interface PaymentRow {
  date: string;
  direction: 'in' | 'out';
  method: string;
  number: string | null;
  partyName: string;
  amountCentimes: number;
  state: string;
}
export interface MovementRow {
  date: string;
  account: string;
  source: string;
  amountCentimes: number;
}
export interface AgeingItem {
  party: string;
  document: string;
  dueDate: string;
  openCentimes: number;
}

const amount = (c: number): CsvCell => num(plainAmount(c));

export function salesJournalCsv(rows: readonly SalesRow[]): string {
  return toCsv([
    ['Pièce', 'Date', 'Client', 'ICE', 'Total HT (MAD)', 'TVA (MAD)', 'Total TTC (MAD)', 'Avoir de'],
    ...rows.map((r) => [
      r.number,
      r.date,
      r.clientName,
      r.clientIce ?? '',
      amount(r.htCentimes),
      amount(r.vatCentimes),
      amount(r.ttcCentimes),
      r.creditNoteOf ?? '',
    ]),
    [
      'Total',
      '',
      '',
      '',
      amount(sum(rows, 'htCentimes')),
      amount(sum(rows, 'vatCentimes')),
      amount(sum(rows, 'ttcCentimes')),
      '',
    ],
  ]);
}

export function purchasesJournalCsv(rows: readonly PurchaseRow[]): string {
  return toCsv([
    [
      'Achat',
      'Date',
      'Fournisseur',
      'Facture fournisseur',
      'Échéance',
      'Total HT (MAD)',
      'TVA (MAD)',
      'Total TTC (MAD)',
    ],
    ...rows.map((r) => [
      r.code,
      r.date,
      r.supplierName,
      r.supplierInvoiceNo ?? '',
      r.dueDate,
      amount(r.htCentimes),
      amount(r.vatCentimes),
      amount(r.ttcCentimes),
    ]),
    [
      'Total',
      '',
      '',
      '',
      '',
      amount(sum(rows, 'htCentimes')),
      amount(sum(rows, 'vatCentimes')),
      amount(sum(rows, 'ttcCentimes')),
    ],
  ]);
}

export function paymentsCsv(payments: readonly PaymentRow[], movements: readonly MovementRow[]): string {
  return toCsv([
    ['Règlements'],
    ['Date', 'Sens', 'Mode', 'Numéro', 'Tiers', 'Montant (MAD)', 'État'],
    ...payments.map((p) => [
      p.date,
      p.direction === 'in' ? 'Encaissement' : 'Décaissement',
      p.method,
      p.number ?? '',
      p.partyName,
      amount(p.amountCentimes),
      p.state,
    ]),
    [],
    ['Mouvements de caisse et de banque'],
    ['Date', 'Compte', 'Origine', 'Montant (MAD)'],
    ...movements.map((m) => [m.date, m.account, m.source, amount(m.amountCentimes)]),
    ['Total', '', '', amount(movements.reduce((s, m) => s + m.amountCentimes, 0))],
  ]);
}

export const AGEING_BUCKETS = ['not_due', 'd0_30', 'd31_60', 'd61_90', 'over_90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Days past the due date → the bucket the accountant reads (a date not yet reached is "not due"). */
export function ageingBucket(dueDate: string, asOf: string): AgeingBucket {
  const late = daysBetween(dueDate, asOf);
  if (late <= 0) return 'not_due';
  if (late <= 30) return 'd0_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'over_90';
}

const BUCKET_LABEL: Record<AgeingBucket, string> = {
  not_due: 'Non échu',
  d0_30: '1 à 30 jours',
  d31_60: '31 à 60 jours',
  d61_90: '61 à 90 jours',
  over_90: 'Plus de 90 jours',
};

export function ageingCsv(
  asOf: string,
  receivables: readonly AgeingItem[],
  payables: readonly AgeingItem[],
): string {
  const block = (title: string, items: readonly AgeingItem[]): CsvCell[][] => {
    const totals = new Map<AgeingBucket, number>(AGEING_BUCKETS.map((b) => [b, 0]));
    for (const i of items)
      totals.set(
        ageingBucket(i.dueDate, asOf),
        (totals.get(ageingBucket(i.dueDate, asOf)) ?? 0) + i.openCentimes,
      );
    return [
      [title],
      ['Tiers', 'Pièce', 'Échéance', 'Reste (MAD)', 'Tranche'],
      ...items.map((i) => [
        i.party,
        i.document,
        i.dueDate,
        amount(i.openCentimes),
        BUCKET_LABEL[ageingBucket(i.dueDate, asOf)],
      ]),
      ...AGEING_BUCKETS.map((b) => ['', '', 'Total ' + BUCKET_LABEL[b], amount(totals.get(b) ?? 0), '']),
      ['', '', 'Total', amount(items.reduce((s, i) => s + i.openCentimes, 0)), ''],
    ];
  };
  return toCsv([
    [`Balance âgée au ${asOf}`],
    [],
    ...block('Créances clients', receivables),
    [],
    ...block('Dettes fournisseurs', payables),
  ]);
}

function sum<T extends Record<K, number>, K extends string>(rows: readonly T[], key: K): number {
  return rows.reduce((s, r) => s + r[key], 0);
}

export type ReconciliationError = 'TOTALS_DO_NOT_ADD_UP' | 'LINES_DO_NOT_MATCH_INVOICES';

/**
 * The journals must tie out before anything is handed over (AC-LED-24): in every row HT + VAT = TTC, and the sales journal
 * equals the invoice lines it was built from, in total.
 */
export function reconcile(input: {
  sales: readonly SalesRow[];
  purchases: readonly PurchaseRow[];
  invoiceLinesHtCentimes: number;
}): Result<true, ReconciliationError> {
  for (const r of [...input.sales, ...input.purchases])
    if (r.htCentimes + r.vatCentimes !== r.ttcCentimes) return err('TOTALS_DO_NOT_ADD_UP');
  if (sum(input.sales, 'htCentimes') !== input.invoiceLinesHtCentimes)
    return err('LINES_DO_NOT_MATCH_INVOICES');
  return ok(true);
}
