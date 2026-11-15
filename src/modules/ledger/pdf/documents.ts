import { formatCentimes } from '@/lib/money';
import { PdfLayout } from '@/lib/pdf/layout';
import { type CompanyProfile, legalFooter } from '../domain/company';
import { type Statement, type StatementRow } from '../domain/statement';
import type { AvoirView } from '../service/avoir-service';
import type { InvoiceDocument } from '../service/invoice-service';
import type { QuoteView } from '../service/quote-service';

/** Printed on every page of a pilot document (fake data): nobody can pass it for a real invoice. */
export const SPECIMEN = 'SPÉCIMEN — données fictives';

export interface PdfContext {
  company: CompanyProfile | null;
  /** True for the pilot: the watermark goes on every page. */
  specimen: boolean;
}

const formatM3 = (litres: number) =>
  (litres / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: false });
const mad = (c: number) => `${formatCentimes(c)} MAD`;
const percent = (bp: number) => `${(bp / 100).toLocaleString('fr-FR')} %`;

function head(title: string, ctx: PdfContext): PdfLayout {
  return new PdfLayout(title, {
    watermark: ctx.specimen ? SPECIMEN : null,
    footer: legalFooter(ctx.company),
  });
}

/** The invoice or credit note: the stored figures only, lines grouped by product with their BL numbers, advance and net to pay. */
export function invoicePdf(doc: InvoiceDocument, ctx: PdfContext): Uint8Array {
  const i = doc.invoice;
  const credit = i.creditNoteOf !== null;
  const page = head(`${credit ? 'Avoir' : 'Facture'} ${i.number}`, ctx);
  page.title(`${credit ? 'Facture d’avoir' : 'Facture'} ${i.number}`);
  page.pairs([
    ['Client', i.clientName],
    ...(i.clientIce ? ([['ICE client', i.clientIce]] as const) : []),
    ['Date', i.invoiceDate],
    ['Échéance', `${i.dueDate} (${doc.termDays} jours)`],
    ['Commandes', i.orderCodes.join(', ')],
    ...(doc.clientPos.length ? ([['N° commande client', doc.clientPos.join(', ')]] as const) : []),
    ...(doc.creditNoteOfNumber ? ([['Annule la facture', doc.creditNoteOfNumber]] as const) : []),
    ...(i.reason ? ([['Motif', i.reason]] as const) : []),
  ]);
  page.gap();
  page.table(
    [
      { header: 'Désignation', width: 0 },
      { header: 'BL', width: 150, font: 'mono' },
      { header: 'Qté m³', width: 52, align: 'right' },
      { header: 'PU HT', width: 62, align: 'right' },
      { header: 'Total HT', width: 72, align: 'right' },
    ],
    doc.groups.map((g) => [
      `${g.typeCode} ${g.typeLabel}`,
      g.blNos.join(' '),
      formatM3(g.volumeL),
      formatCentimes(g.unitPriceHtCentimes),
      formatCentimes(Number(g.amountHtCentimes)),
    ]),
  );
  page.gap(4);
  page.totals(
    [
      ['Total HT', mad(i.totalHtCentimes)],
      [`TVA ${percent(i.vatRateBp)}`, mad(i.totalVatCentimes)],
      ['Total TTC', mad(i.totalTtcCentimes)],
      ...(doc.advanceCentimes > 0
        ? ([
            ['Acompte reçu', mad(doc.advanceCentimes)],
            ['Net à payer', mad(doc.netToPayCentimes)],
          ] as const)
        : []),
    ],
    { boldLast: true },
  );
  page.gap();
  page.paragraph(`Paiement à ${doc.termDays} jours, loi 69-21 sur les délais de paiement.`, {
    size: 8,
    gray: 0.35,
  });
  return page.build();
}

/** The avoir: it references the invoice, the BL and the reason, with its own number. */
export function avoirPdf(a: AvoirView, ctx: PdfContext): Uint8Array {
  const page = head(`Avoir ${a.number}`, ctx);
  page.title(`Avoir ${a.number}`);
  page.pairs([
    ['Client', a.clientName],
    ['Date', a.avoirDate],
    ['Facture', a.invoiceNumber],
    ['Bon de livraison', a.blNo],
    ['Motif', a.reason],
  ]);
  page.gap();
  page.table(
    [
      { header: 'Désignation', width: 0 },
      { header: 'Qté m³', width: 70, align: 'right' },
      { header: 'PU HT', width: 80, align: 'right' },
    ],
    [[`Béton refusé ou retourné (${a.blNo})`, formatM3(a.volumeL), formatCentimes(a.unitPriceHtCentimes)]],
  );
  page.gap(4);
  page.totals(
    [
      ['Total HT', mad(a.totalHtCentimes)],
      [`TVA ${percent(a.vatRateBp)}`, mad(a.totalVatCentimes)],
      ['Total TTC crédité', mad(a.totalTtcCentimes)],
    ],
    { boldLast: true },
  );
  return page.build();
}

export function quotePdf(q: QuoteView, ctx: PdfContext): Uint8Array {
  const page = head(`Devis ${q.code}`, ctx);
  page.title(`Devis ${q.code}`);
  page.pairs([
    ['Client', q.clientName],
    ...(q.clientIce ? ([['ICE client', q.clientIce]] as const) : []),
    ['Date', q.quoteDate],
    ['Valable jusqu’au', q.validUntil],
  ]);
  page.gap();
  page.table(
    [
      { header: 'Désignation', width: 0 },
      { header: 'Qté m³', width: 70, align: 'right' },
      { header: 'PU HT', width: 80, align: 'right' },
    ],
    [[`${q.typeCode} ${q.typeLabel}`, formatM3(q.volumeL), formatCentimes(q.unitPriceHtCentimes)]],
  );
  page.gap(4);
  page.totals(
    [
      ['Total HT', mad(q.totalHtCentimes)],
      [`TVA ${percent(q.vatRateBp)}`, mad(q.totalVatCentimes)],
      ['Total TTC', mad(q.totalTtcCentimes)],
    ],
    { boldLast: true },
  );
  return page.build();
}

const STATEMENT_TYPE: Record<string, string> = {
  opening: 'Ouverture',
  order: 'Commande',
  order_cancelled: 'Commande annulée',
  purchase: 'Achat',
  purchase_cancelled: 'Achat annulé',
  invoice: 'Facture',
  credit_note: 'Avoir',
  avoir: 'Avoir',
  supplier_invoice: 'Fact. fournisseur',
  payment: 'Paiement',
};

/** The statement of one client or supplier, one table of every line with the running balance. */
export function statementPdf(
  kind: 'client' | 'supplier',
  party: { code: string; name: string },
  statement: Statement,
  today: string,
  ctx: PdfContext,
): Uint8Array {
  const label = kind === 'client' ? 'Relevé client' : 'Relevé fournisseur';
  const page = head(`${label} ${party.code}`, ctx);
  page.title(`${label} ${party.code}`);
  page.pairs([
    [kind === 'client' ? 'Client' : 'Fournisseur', party.name],
    ['Édité le', today],
    ['Reporté', mad(Number(statement.carriedIn))],
  ]);
  page.gap();
  const rows: StatementRow[] = [...statement.commercial, ...statement.financial].sort(
    (a, b) => a.date.localeCompare(b.date) || a.section.localeCompare(b.section) || a.id.localeCompare(b.id),
  );
  page.table(
    [
      { header: 'Date', width: 58 },
      { header: 'Type', width: 66 },
      { header: 'Pièce', width: 110, font: 'mono' },
      { header: 'État', width: 70 },
      { header: 'Montant', width: 80, align: 'right' },
      { header: 'Solde', width: 0, align: 'right' },
    ],
    rows.map((r) => [
      r.date,
      STATEMENT_TYPE[r.type] ?? r.type,
      r.code ?? '',
      r.status,
      formatCentimes(Number(r.amountCentimes)),
      formatCentimes(Number(r.balanceAfter)),
    ]),
  );
  page.gap(4);
  page.totals(
    [
      ['En retard', mad(Number(statement.summary.late))],
      ['Solde de clôture', mad(Number(statement.closing))],
    ],
    { boldLast: true },
  );
  return page.build();
}
