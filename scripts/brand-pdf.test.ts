import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { invoicePdf, statementPdf } from '../src/modules/ledger/pdf/documents';
import {
  legalFooter,
  LEGAL_FOOTER_PLACEHOLDER,
  type CompanyProfile,
} from '../src/modules/ledger/domain/company';
import { deliveryNotePdf } from '../src/modules/operations/pdf/delivery-note-pdf';
import { KAYAS_SIGNATURE_PDF } from '../src/lib/pdf/brand-logo-data';
import { PdfLayout } from '../src/lib/pdf/layout';
import { readPdf } from '../src/lib/pdf/read-text';

const company: CompanyProfile = {
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
const ctx = { company, specimen: true };
function contentOf(bytes: Buffer): string {
  const text = bytes.toString('latin1');
  return [...text.matchAll(/\/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)]
    .map((m) =>
      inflateSync(
        bytes.subarray((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + Number(m[1])),
      ).toString('latin1'),
    )
    .join('\n');
}
const norm = (s: string) => s.replace(/[  ]/g, ' ');

describe('KAYAS logo in PDFs', () => {
  it('the vector data is exactly the SVG of public/brand/svg (no drift) and holds no raster', () => {
    const svgFile = 'public/brand/svg/kayas-signature-colour.svg';
    const sha = createHash('sha256').update(readFileSync(svgFile)).digest('hex');
    expect(KAYAS_SIGNATURE_PDF.sourceSha256).toBe(sha);
    expect(KAYAS_SIGNATURE_PDF.width / KAYAS_SIGNATURE_PDF.height).toBeCloseTo(1278 / 279, 5);
    const fills = KAYAS_SIGNATURE_PDF.paths.map((p) => p.fill.map((v) => Math.round(v * 255)).join(','));
    expect(new Set(fills)).toEqual(new Set(['1,89,43', '154,218,2'])); // Forêt and Citron only
    const svg = readFileSync(svgFile, 'utf8');
    const segments = (svg.match(/ C /g)?.length ?? 0) + (svg.match(/ L /g)?.length ?? 0);
    const ops = KAYAS_SIGNATURE_PDF.paths.map((p) => p.ops).join(' ');
    expect(
      (ops.match(/ c(?= |$)/g)?.length ?? 0) + (ops.match(/ l(?= |$)/g)?.length ?? 0),
    ).toBeGreaterThanOrEqual(segments - 20);
  });

  it('every page of a PDF is well formed; the logo is vector paths (no image); Citron and Forêt are in the content', () => {
    const page = new PdfLayout('t', { footer: legalFooter(company) });
    page.title('Titre');
    page.table([{ header: 'A', width: 0 }], [['x']]);
    const bytes = Buffer.from(page.build());
    const text = bytes.toString('latin1');
    expect(readPdf(bytes).pages).toHaveLength(1);
    expect(text).not.toContain('/Subtype /Image');
    const all = contentOf(bytes);
    expect(all).toMatch(/ c\n| c /); // curves
    expect(all).toContain('0.00392 0.34902 0.16863 rg'); // Forêt fill of the logo
    expect(all).toContain('0.60392 0.85490 0.00784 rg'); // Citron fill of the logo
    expect(all).toContain('0.60392 0.85490 0.00784 RG'); // Citron rule
    expect(all).toMatch(/1\.00000 1\.00000 1\.00000 rg BT/); // white header text on the Forêt band
  });

  it('the logo is never stretched: the flip matrix scales x and y equally', () => {
    const all = contentOf(Buffer.from(new PdfLayout('t').build()));
    const m = /q ([\d.]+) 0 0 (-[\d.]+) [\d.]+ [\d.]+ cm/.exec(all);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(-Number(m![2]), 5);
  });

  it('legal footer: built from the owner-filled profile only; without one, a neutral placeholder and nothing invented', () => {
    expect(legalFooter(company)[0]).toBe(
      'Société Fictive SARL (SARL) - ICE 001234567000089 / RC 98765 - 1 rue du Test, Tétouan',
    );
    expect(legalFooter(null)).toEqual([LEGAL_FOOTER_PLACEHOLDER]);
    const bare = readPdf(invoicePdf(invoiceFixture(), { company: null, specimen: false })).pages[0]!;
    expect(norm(bare)).toContain(LEGAL_FOOTER_PLACEHOLDER);
  });
});

function invoiceFixture(): Parameters<typeof invoicePdf>[0] {
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
    groups: [
      {
        typeCode: 'B25',
        typeLabel: 'Béton B25',
        blNos: ['BL-1', 'BL-2'],
        volumeL: 8000,
        unitPriceHtCentimes: 15432,
        amountHtCentimes: 123456n,
      },
    ],
    advanceCentimes: 0,
    netToPayCentimes: 148147,
    termDays: 30,
  } as unknown as Parameters<typeof invoicePdf>[0];
}

describe('the rebrand did not change a single amount (golden figures)', () => {
  it('invoice: HT, TVA, TTC, quantities, unit price and numbering are exactly the stored figures', () => {
    const page = norm(readPdf(invoicePdf(invoiceFixture(), ctx)).pages[0]!);
    for (const expected of [
      'Facture FA-2026-00042',
      'Total HT',
      '1 234,56 MAD',
      'TVA 20 %',
      '246,91 MAD',
      'Total TTC',
      '1 481,47 MAD',
      '154,32',
      'B25 Béton B25',
      'BL-1 BL-2',
    ])
      expect(page).toContain(expected);
  });

  it('delivery note carries no price and the statement keeps its closing figures', () => {
    const note = {
      blNo: 'BL-2026-00007',
      cancelled: false,
      loadDate: '2026-11-07',
      loadedAt: '2026-11-07T08:30:00.000Z',
      orderCode: 'CMD-1',
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
    const bl = readPdf(deliveryNotePdf(note, { specimen: true, company: legalFooter(company) })).pages[0]!;
    expect(bl).toContain('Bon de livraison BL-2026-00007');
    expect(bl).not.toMatch(/MAD|TVA|Total/);
    const st = readPdf(
      statementPdf(
        'client',
        { code: 'CL-01', name: 'Client Fictif' },
        {
          carriedIn: 0n,
          commercial: [],
          financial: [],
          summary: { late: 5000n },
          closing: 123456n,
        } as unknown as Parameters<typeof statementPdf>[2],
        '2026-11-07',
        ctx,
      ),
    ).pages[0]!;
    expect(norm(st)).toContain('Solde de clôture');
    expect(norm(st)).toContain('1 234,56 MAD');
    expect(norm(st)).toContain('50,00 MAD');
  });
});
