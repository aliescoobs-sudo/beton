import { describe, expect, it } from 'vitest';
import { A4, FOOTER, PdfDocument, textWidth, winAnsi, type Font } from '../src/lib/pdf/pdf';
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS } from '../src/lib/pdf/helvetica-metrics';
import {
  formatRib,
  legalBlockFits,
  legalFooter,
  type CompanyProfile,
} from '../src/modules/ledger/domain/company';
import { invoicePdf, statementPdf } from '../src/modules/ledger/pdf/documents';
import { deliveryNotePdf } from '../src/modules/operations/pdf/delivery-note-pdf';
import {
  inkExtent,
  pagesAsPixels,
  rendererAvailable,
  wordsOf,
  type PageWords,
} from '../tests/helpers/pdf-oracle';
import { invoiceDoc, maximum, note, short, statementDoc, unbroken } from '../tests/helpers/pdf-fixtures';

/**
 * R17-06, the independent acceptance: the pages are rendered by poppler (pdftoppm for the pixels, pdftotext -bbox for the word boxes of the
 * renderer itself), NOT measured with the writer's own width function. A missing renderer fails CI (REQUIRE_PDF_RENDERER=1) and skips locally.
 */
const have = rendererAvailable();
if (process.env.REQUIRE_PDF_RENDERER === '1' && !have)
  throw new Error('REQUIRE_PDF_RENDERER=1 but pdftoppm / pdftotext are not installed');
const suite = describe.skipIf(!have);

const repeat = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
/** The review's counterexample and the widest glyphs, on top of the ordinary profiles. */
const profiles: [string, CompanyProfile][] = [
  ['a short profile', short],
  ['the longest ordinary profile', maximum],
  [
    '200 Æ in the legal name (the counterexample of the review)',
    { ...short, legalName: 'Æ'.repeat(200), address: repeat('Œuvre Æolienne ', 300).trim() },
  ],
  [
    'wide glyphs everywhere',
    {
      ...short,
      legalName: repeat('ÆŒWM@%— ', 200).trim(),
      legalForm: repeat('ŒÆ ', 60).trim(),
      address: repeat('MW@ÆŒ%&', 300),
    },
  ],
  ['unbroken capitals', unbroken],
];

const squash = (s: string) => s.replace(/[\s  ]/g, '');
const PX = 2; // 144 dpi

function assertPages(bytes: Uint8Array, p: CompanyProfile, withRib: boolean, minPages = 1) {
  const pages: PageWords[] = wordsOf(bytes);
  const pixels = pagesAsPixels(bytes, 72 * PX);
  expect(pages.length).toBeGreaterThanOrEqual(minPages);
  expect(pixels.length).toBe(pages.length);
  pages.forEach((page, n) => {
    const where = `page ${n + 1}/${pages.length}`;
    expect(page.width).toBeCloseTo(A4.width, 1);
    const footer = page.words.filter((w) => w.yMin > page.height - 130 && w.yMax - w.yMin < 9.6);
    expect(footer.length, where).toBeGreaterThan(0);
    // 1. the renderer's own boxes: every footer word is inside the margins, every word of the page is inside the page
    for (const w of footer) {
      expect(w.xMin, `${where}: "${w.text}" starts left of the margin`).toBeGreaterThanOrEqual(
        FOOTER.margin - 0.5,
      );
      expect(w.xMax, `${where}: "${w.text}" ends right of the margin`).toBeLessThanOrEqual(
        A4.width - FOOTER.margin + 0.5,
      );
    }
    for (const w of page.words) {
      expect(w.xMin, where).toBeGreaterThanOrEqual(0);
      expect(w.xMax, `${where}: "${w.text}"`).toBeLessThanOrEqual(page.width);
    }
    // 2. the pixels: the footer band's ink does not touch the margins either (what a printer or a PDF viewer shows)
    const top = Math.min(...footer.map((w) => w.yMin)) * PX - 2;
    const bottom = Math.max(...footer.map((w) => w.yMax)) * PX + 2;
    const ink = inkExtent(pixels[n]!, top, bottom);
    expect(ink, `${where}: the footer band has ink`).not.toBeNull();
    expect(ink!.minX, `${where}: ink left of the margin`).toBeGreaterThanOrEqual((FOOTER.margin - 1) * PX);
    expect(ink!.maxX, `${where}: ink right of the margin`).toBeLessThanOrEqual(
      (A4.width - FOOTER.margin + 1) * PX,
    );
    // 3. every legal field is there, whole (a force-broken word joins back), on every page
    const block = squash(footer.map((w) => w.text).join(''));
    const fields = [p.legalName, p.legalForm, p.ice, p.rcNumber, p.ifNumber, p.patente, p.address];
    if (withRib && p.rib) fields.push(formatRib(p.rib));
    for (const f of fields) {
      // what the renderer extracts is what was DRAWN: a character outside WinAnsi was drawn as "?"
      const drawn = new TextDecoder('windows-1252').decode(winAnsi(f));
      expect(block, `${where}: missing "${f.slice(0, 24)}…"`).toContain(squash(drawn).normalize('NFC'));
    }
    // 4. the page's own content stays above the footer box
    const boxTop = Math.min(...footer.map((w) => w.yMin));
    for (const w of page.words.filter((x) => !footer.includes(x) && x.yMax < page.height - 130 + 100))
      expect(w.yMax, `${where}: "${w.text}" overlaps the footer`).toBeLessThanOrEqual(boxTop + 0.5);
  });
}

suite(
  'R17-06: every page of every document, rendered by poppler, keeps the legal identity inside the page',
  () => {
    it.each(profiles)('%s is accepted by the profile validation (same complete metrics)', (_n, p) => {
      expect(legalBlockFits(p)).toBe(true);
    });

    for (const [name, p] of profiles) {
      it(`${name}: invoice (1 and several pages), statement (several), delivery note (1 and several)`, () => {
        const ctx = { company: p, specimen: false };
        assertPages(invoicePdf(invoiceDoc(2), ctx), p, true);
        assertPages(invoicePdf(invoiceDoc(90), ctx), p, true, 2);
        assertPages(
          statementPdf(
            'client',
            { code: 'CL-01', name: 'Client Fictif' },
            statementDoc(150),
            '2026-11-07',
            ctx,
          ),
          p,
          true,
          2,
        );
        const company = legalFooter({ ...p, rib: null });
        assertPages(deliveryNotePdf(note, { specimen: false, company }), p, false);
        // a multi-page BL: details that wrap onto further pages (the writer paginates a long block)
        const long = {
          ...note,
          siteLabel: repeat('Chantier de la zone industrielle ', 9000),
          zoneName: 'Zone',
        };
        assertPages(deliveryNotePdf(long, { specimen: false, company }), p, false, 2);
      }, 30_000);
    }
  },
);

suite('R17-06: the width table agrees with the renderer, glyph by glyph', () => {
  // The renderer lays out the very same bytes with the Adobe metrics of Helvetica: each word box must match our width within a point.
  const samples: [string, Font][] = [
    ['ÆÆÆÆÆÆÆÆÆÆ', 'regular'],
    ['ŒŒŒŒŒŒŒŒŒŒ', 'regular'],
    ['WWWWWWWWWW', 'regular'],
    ['MMMMMMMMMM', 'bold'],
    ['ÆŒ@%‰WM—…•', 'bold'],
    ['Société', 'regular'],
    ['Établissements', 'bold'],
    ['ÀÉÎÔÛçñüÿß', 'regular'],
    ['0123456789', 'regular'],
    ['iiiiiiiiii', 'regular'],
    ['€£¥©®±½¼¾', 'regular'],
  ];
  it.each(samples)('"%s" (%s)', (text, font) => {
    // one document: a text line each at 20 pt, the renderer reports its box
    const size = 20;
    const widthByRenderer = renderedWidth(text, font, size);
    expect(widthByRenderer).toBeGreaterThan(0);
    expect(Math.abs(widthByRenderer - textWidth(text, size, font))).toBeLessThan(0.6);
  });

  it('the table covers every byte the writer can emit, and the review’s wide glyphs are 1000 units', () => {
    for (const table of [HELVETICA_WIDTHS, HELVETICA_BOLD_WIDTHS]) {
      for (let b = 0x20; b <= 0x7e; b++) expect(table.has(b), `0x${b.toString(16)}`).toBe(true);
      for (let b = 0xa1; b <= 0xff; b++) expect(table.has(b), `0x${b.toString(16)}`).toBe(true);
      for (const b of [0x80, 0x85, 0x8c, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x9c])
        expect(table.has(b)).toBe(true);
      expect(table.get(0xc6)).toBe(1000);
      expect(table.get(0x8c)).toBe(1000);
    }
  });
});

/** The width the RENDERER gives a single word at a size, from a one-line document. */
function renderedWidth(text: string, font: Font, size: number): number {
  const doc = new PdfDocument({ title: 'metrics' });
  doc.text(100, 700, text, { size, font });
  const words = wordsOf(doc.build())[0]!.words;
  const w = words.find((x) => squash(x.text).length > 0)!;
  return w.xMax - w.xMin;
}
