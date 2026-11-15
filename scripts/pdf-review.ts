// Writes one invoice, one delivery note and one statement (FICTITIOUS figures) as PDFs into a folder OUTSIDE the repository, for a
// visual review of the KAYAS layout (convert with `sips -s format png`). Usage:
//   node --import ./scripts/register-ts-paths.mjs scripts/pdf-review.ts <output-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoicePdf, statementPdf } from '../src/modules/ledger/pdf/documents.ts';
import type { CompanyProfile } from '../src/modules/ledger/domain/company.ts';
import { legalFooter } from '../src/modules/ledger/domain/company.ts';
import { deliveryNotePdf } from '../src/modules/operations/pdf/delivery-note-pdf.ts';

const usage = 'usage: node --import ./scripts/register-ts-paths.mjs scripts/pdf-review.ts <output-dir>';
const out = process.argv[2];
if (out === '--help' || out === '-h') {
  console.log(usage);
  process.exit(0);
}
if (!out) throw new Error(usage);
mkdirSync(out, { recursive: true });
const company: CompanyProfile = {
  effectiveFrom: '2026-01-01',
  legalName: 'Société fictive SARL',
  legalForm: 'SARL',
  ice: '001234567000089',
  ifNumber: '12345678',
  rcNumber: '98765',
  patente: '55501234',
  address: '1 rue du Test, Tétouan (fictif)',
  phone: null,
  email: null,
  rib: '181780000012345678901234',
};
const ctx = { company, specimen: true };
const cast = <T>(v: unknown) => v as T;

writeFileSync(
  join(out, 'facture.pdf'),
  invoicePdf(
    cast({
      invoice: {
        number: 'FA-2026-00042',
        creditNoteOf: null,
        clientName: 'Client fictif',
        clientIce: '009876543000012',
        invoiceDate: '2026-11-07',
        dueDate: '2026-12-07',
        orderCodes: ['CMD-0001'],
        reason: null,
        totalHtCentimes: 123456,
        vatRateBp: 2000,
        totalVatCentimes: 24691,
        totalTtcCentimes: 148147,
      },
      creditNoteOfNumber: null,
      lines: [],
      groups: [
        {
          typeCode: 'B25',
          typeLabel: 'Béton B25 pompable',
          blNos: ['BL-1', 'BL-2'],
          volumeL: 8000,
          unitPriceHtCentimes: 15432,
          amountHtCentimes: 123456n,
        },
      ],
      advanceCentimes: 0,
      netToPayCentimes: 148147,
      termDays: 30,
      clientPos: [],
    }),
    ctx,
  ),
);
writeFileSync(
  join(out, 'bon-de-livraison.pdf'),
  deliveryNotePdf(
    cast({
      blNo: 'BL-2026-00007',
      cancelled: false,
      loadDate: '2026-11-07',
      loadedAt: '2026-11-07T08:30:00.000Z',
      orderCode: 'CMD-0001',
      clientPo: null,
      clientName: 'Client fictif',
      clientCode: 'CL-01',
      siteLabel: 'Chantier test',
      zoneName: 'Zone industrielle',
      typeCode: 'B25',
      typeLabel: 'Béton B25',
      volumeL: 8000,
      truckCode: 'T1',
      truckPlate: '1234-A-1',
    }),
    { specimen: true, company: legalFooter({ ...company, rib: null }) },
  ),
);
writeFileSync(
  join(out, 'releve-client.pdf'),
  statementPdf(
    'client',
    { code: 'CL-01', name: 'Client fictif' },
    cast({
      carriedIn: 0n,
      commercial: [
        {
          id: '1',
          section: 'c',
          date: '2026-11-01',
          type: 'invoice',
          code: 'FA-2026-00042',
          status: 'due',
          amountCentimes: 148147n,
          balanceAfter: 148147n,
        },
      ],
      financial: [
        {
          id: '2',
          section: 'f',
          date: '2026-11-05',
          type: 'payment',
          code: 'PAY-0001',
          status: 'ok',
          amountCentimes: -50000n,
          balanceAfter: 98147n,
        },
      ],
      summary: { late: 0n },
      closing: 98147n,
    }),
    '2026-11-08',
    ctx,
  ),
);
console.log(`PDF written to ${out}`);
