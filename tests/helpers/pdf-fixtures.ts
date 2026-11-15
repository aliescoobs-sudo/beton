import type { CompanyProfile } from '../../src/modules/ledger/domain/company';
import type { invoicePdf, statementPdf } from '../../src/modules/ledger/pdf/documents';
import type { deliveryNotePdf } from '../../src/modules/operations/pdf/delivery-note-pdf';

// Synthetic documents shared by the PDF tests (fictitious data only).

export const short: CompanyProfile = {
  effectiveFrom: '2026-01-01',
  legalName: 'Société Fictive SARL',
  legalForm: 'SARL',
  ice: '001234567000089',
  ifNumber: '12345678',
  rcNumber: '98765',
  patente: '55501234',
  address: '1 rue du Test, Tétouan',
  phone: null,
  email: null,
  rib: '181780000012345678901234',
};
export const words = (n: number, w = 'Établissements') =>
  Array.from({ length: Math.ceil(n / (w.length + 1)) }, () => w)
    .join(' ')
    .slice(0, n)
    .trim();
export const maximum: CompanyProfile = {
  ...short,
  legalName: words(200, 'Société Fictive des Matériaux'),
  legalForm: words(60, 'Société anonyme'),
  ifNumber: '1'.repeat(30),
  rcNumber: '9'.repeat(40),
  patente: '5'.repeat(40),
  address: words(300, 'Zone industrielle Tétouan'),
};
export const unbroken: CompanyProfile = { ...maximum, legalName: 'W'.repeat(200), address: 'M'.repeat(300) };

export function invoiceDoc(groups: number): Parameters<typeof invoicePdf>[0] {
  return {
    invoice: {
      number: 'FA-2026-00042',
      creditNoteOf: null,
      clientName: 'Client Fictif',
      clientIce: null,
      invoiceDate: '2026-11-07',
      dueDate: '2026-12-07',
      orderCodes: ['CMD-1'],
      reason: null,
      totalHtCentimes: 123456,
      vatRateBp: 2000,
      totalVatCentimes: 24691,
      totalTtcCentimes: 148147,
    },
    creditNoteOfNumber: null,
    lines: [],
    groups: Array.from({ length: groups }, (_, k) => ({
      typeCode: 'B25',
      typeLabel: 'Béton B25',
      blNos: [`BL-${k}`],
      volumeL: 8000,
      unitPriceHtCentimes: 15432,
      amountHtCentimes: 123456n,
    })),
    advanceCentimes: 0,
    netToPayCentimes: 148147,
    termDays: 30,
    clientPos: [],
  } as unknown as Parameters<typeof invoicePdf>[0];
}
export const note = {
  blNo: 'BL-2026-00007',
  cancelled: false,
  loadDate: '2026-11-07',
  loadedAt: '2026-11-07T08:30:00.000Z',
  orderCode: 'CMD-1',
  clientPo: null,
  clientName: 'Client Fictif',
  clientCode: 'CL-01',
  siteLabel: 'Chantier',
  zoneName: 'Zone',
  typeCode: 'B25',
  typeLabel: 'Béton B25',
  volumeL: 8000,
  truckCode: 'T1',
  truckPlate: '1234-A-1',
} as unknown as Parameters<typeof deliveryNotePdf>[0];
export function statementDoc(rows: number) {
  const line = (k: number) => ({
    id: `id-${String(k).padStart(4, '0')}`,
    section: 'commercial',
    date: '2026-11-01',
    type: 'order',
    code: `CMD-2026-${String(k).padStart(5, '0')}`,
    status: 'ok',
    amountCentimes: 1000n,
    balanceAfter: BigInt(1000 * k),
    counted: true,
  });
  return {
    carriedIn: 0n,
    commercial: Array.from({ length: rows }, (_, k) => line(k)),
    financial: [],
    summary: { late: 5000n },
    closing: 123456n,
  } as unknown as Parameters<typeof statementPdf>[2];
}
