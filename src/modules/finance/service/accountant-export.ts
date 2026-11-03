import type pg from 'pg';
import { subtract, sum, integer } from '../domain/money';
import { xlsx, type Cell } from '../domain/xlsx';
import { financeRequest, type FinanceActor } from './request';
import { validRange } from './report-service';
export interface JournalRow {
  journal: 'sales' | 'purchases';
  number: string;
  date: string;
  party: string;
  ice?: string | null;
  creditNoteOf?: string | null;
  supplierInvoiceNo?: string | null;
  htCentimes: number;
  vatCentimes: number;
  ttcCentimes: number;
  vatRateBp: number;
  lineHtCentimes?: number;
}
export function accountantWorkbook(rows: JournalRow[], from: string, to: string) {
  for (const r of rows)
    if (sum([integer(r.htCentimes), integer(r.vatCentimes)]) !== integer(r.ttcCentimes))
      throw new Error('JOURNAL_DOES_NOT_RECONCILE');
  for (const r of rows)
    if (r.lineHtCentimes !== undefined && integer(r.lineHtCentimes) !== r.htCentimes)
      throw new Error('INVOICE_LINES_DO_NOT_RECONCILE');
  const journal = (rs: JournalRow[]): Cell[][] => [
    [
      'Pièce',
      'Date',
      'Tiers',
      'ICE',
      'Facture fournisseur',
      'Avoir de',
      'HT (MAD)',
      'TVA (MAD)',
      'TTC (MAD)',
      'TVA (%)',
    ],
    ...rs.map((r) => [
      r.number,
      { date: r.date },
      r.party,
      r.ice ?? '',
      r.supplierInvoiceNo ?? '',
      r.creditNoteOf ?? '',
      r.htCentimes / 100,
      r.vatCentimes / 100,
      r.ttcCentimes / 100,
      r.vatRateBp / 100,
    ]),
  ];
  const sales = rows.filter((r) => r.journal === 'sales'),
    purchases = rows.filter((r) => r.journal === 'purchases');
  const rates = [...new Set(rows.map((r) => r.vatRateBp))].sort((a, b) => a - b);
  return xlsx([
    {
      name: 'TVA',
      rows: [
        ['Période', from, to],
        [
          'TVA (%)',
          'Ventes HT (MAD)',
          'TVA collectée (MAD)',
          'Achats HT (MAD)',
          'TVA achats (MAD)',
          'Solde indicatif (MAD)',
        ],
        ...rates.map((rate) => {
          const s = sales.filter((r) => r.vatRateBp === rate),
            p = purchases.filter((r) => r.vatRateBp === rate);
          const sv = sum(s.map((r) => r.vatCentimes)),
            pv = sum(p.map((r) => r.vatCentimes));
          return [
            rate / 100,
            sum(s.map((r) => r.htCentimes)) / 100,
            sv / 100,
            sum(p.map((r) => r.htCentimes)) / 100,
            pv / 100,
            subtract(sv, pv) / 100,
          ];
        }),
        ['Synthèse des documents enregistrés. Déductibilité et déclaration à valider par le comptable.'],
      ],
    },
    { name: 'Ventes', rows: journal(sales) },
    { name: 'Achats', rows: journal(purchases) },
    { name: 'Avoirs', rows: journal(sales.filter((r) => r.creditNoteOf || r.htCentimes < 0)) },
  ]);
}
export async function exportAccountant(pool: pg.Pool, actor: FinanceActor, from: string, to: string) {
  validRange(from, to);
  return financeRequest(pool, actor, 'finance.export', async (tx) => {
    const rows = (
      await tx.query<{ data: JournalRow[] }>('select finance.accounting_journal($1,$2) data', [from, to])
    ).rows[0]!.data;
    return accountantWorkbook(rows, from, to);
  });
}
