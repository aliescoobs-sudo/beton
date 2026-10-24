import { type CsvCell, num, toCsv } from '@/lib/csv';
import type { Statement, StatementRow } from './statement';

/** 123456 → "1234,56": a decimal comma and no thousands separator, so that a spreadsheet reads a number. */
export function plainAmount(amountCentimes: number): string {
  const abs = Math.abs(amountCentimes);
  return `${amountCentimes < 0 ? '-' : ''}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

const HEADER = ['Date', 'Section', 'Type', 'Pièce', 'État', 'Montant (MAD)', 'Solde (MAD)'];

/** The statement as CSV (French headers: the file goes to the accountant). Amounts have a decimal comma. */
export function statementToCsv(party: { code: string; name: string }, statement: Statement): string {
  const row = (r: StatementRow): CsvCell[] => [
    r.date,
    r.section === 'commercial' ? 'Commercial' : 'Financier',
    r.type,
    r.code ?? '',
    r.status,
    num(plainAmount(Number(r.amountCentimes))),
    num(plainAmount(Number(r.balanceAfter))),
  ];
  const rows = [...statement.commercial, ...statement.financial].sort(
    (a, b) => a.date.localeCompare(b.date) || a.section.localeCompare(b.section) || a.id.localeCompare(b.id),
  );
  return toCsv([
    [party.code, party.name],
    HEADER,
    ...rows.map(row),
    ['', '', '', '', 'Solde de clôture', '', num(plainAmount(Number(statement.closing)))],
  ]);
}
