import { PdfLayout } from '@/lib/pdf/layout';
import type { DeliveryNote } from '../service/delivery-note';
import { formatM3 } from '../ui/format';

/** The BL as a PDF: names, places and quantities, never a price, a total or a payment (AC-OPS-11). */
export function deliveryNotePdf(
  note: DeliveryNote,
  options: { specimen: boolean; company: string[] },
): Uint8Array {
  const page = new PdfLayout(`BL ${note.blNo}`, {
    watermark: options.specimen ? 'SPÉCIMEN — données fictives' : null,
    footer: options.company,
  });
  page.title(`Bon de livraison ${note.blNo}${note.cancelled ? ' — ANNULÉ' : ''}`);
  page.pairs([
    ['Date', note.loadDate],
    ['Chargé à', note.loadedAt.slice(11, 16)],
    ['Commande', note.orderCode],
    ['Client', note.clientName ? `${note.clientName} (${note.clientCode})` : note.clientCode],
    ['Chantier', [note.siteLabel, note.zoneName].filter(Boolean).join(' — ') || '—'],
    ['Béton', `${note.typeCode} ${note.typeLabel}`],
    ['Quantité', `${formatM3(note.volumeL)} m³`],
    ['Camion', `${note.truckCode} · ${note.truckPlate}`],
  ]);
  page.gap(30);
  page.pairs([['Reçu par (nom, signature)', '']]);
  page.gap(40);
  page.rule();
  return page.build();
}
