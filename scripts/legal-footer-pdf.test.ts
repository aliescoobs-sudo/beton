import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { A4, FOOTER, textWidth, type Font } from '../src/lib/pdf/pdf';
import {
  formatRib,
  legalBlockFits,
  legalFooter,
  parseCompanyProfileInput,
  type CompanyProfile,
} from '../src/modules/ledger/domain/company';
import { invoicePdf, statementPdf } from '../src/modules/ledger/pdf/documents';
import { deliveryNotePdf } from '../src/modules/operations/pdf/delivery-note-pdf';
import { invoiceDoc, maximum, note, short, statementDoc, unbroken } from '../tests/helpers/pdf-fixtures';

// R16-01: the legal identity of the seller must stay inside the page on every page of every document. The assertions read the real glyph
// positions in the content streams (x, y, size, text), not the extracted text, which finds strings even when they are off the page.

interface Glyphs {
  font: Font;
  size: number;
  x: number;
  y: number;
  text: string;
}
const FONT_OF: Record<string, Font> = { F1: 'regular', F2: 'bold', F3: 'mono', F4: 'monoBold' };
function pagesOf(bytes: Uint8Array): Glyphs[][] {
  const buf = Buffer.from(bytes);
  const raw = buf.toString('latin1');
  return [...raw.matchAll(/\/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)].map((m) => {
    const from = (m.index ?? 0) + m[0].length;
    const content = inflateSync(buf.subarray(from, from + Number(m[1]))).toString('latin1');
    // the watermark is rotated and drawn under q … Q: only plain text operators are measured
    const plain = content.replace(/q [^\n]*? cm BT[^\n]*? ET Q/g, '');
    return [...plain.matchAll(/\/(F\d) ([\d.]+) Tf (-?[\d.]+) (-?[\d.]+) Td <([0-9a-f]*)> Tj/g)].map((t) => ({
      font: FONT_OF[t[1] as string] as Font,
      size: Number(t[2]),
      x: Number(t[3]),
      y: Number(t[4]),
      text: Buffer.from(t[5] as string, 'hex').toString('latin1'),
    }));
  });
}
const isFooter = (g: Glyphs) => g.size === FOOTER.size && g.y < 130;
const squash = (s: string) => s.replace(/[\s  ]/g, '');

function assertLegalBlock(pages: Glyphs[][], p: CompanyProfile, withRib: boolean) {
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    const foot = page.filter(isFooter);
    expect(foot.length).toBeGreaterThan(0);
    for (const g of foot) {
      const w = textWidth(g.text, g.size, g.font);
      expect(g.x, `"${g.text}" starts left of the margin`).toBeGreaterThanOrEqual(FOOTER.margin - 0.01);
      expect(g.x + w, `"${g.text}" ends right of the margin`).toBeLessThanOrEqual(
        A4.width - FOOTER.margin + 0.01,
      );
      expect(g.size).toBeGreaterThanOrEqual(7); // legible
    }
    // every legal field, whole, in the footer box of this page (force-broken words join back)
    const block = squash(foot.map((g) => g.text).join(''));
    const fields = [p.legalName, p.legalForm, p.ice, p.rcNumber, p.ifNumber, p.patente, p.address];
    if (withRib && p.rib) fields.push(formatRib(p.rib));
    for (const f of fields) expect(block, `missing "${f.slice(0, 30)}…"`).toContain(squash(f));
    // nothing of the page's own content overlaps the footer box
    const top = Math.min(...foot.map((g) => g.y)) + (foot.length - 1) * FOOTER.leading + FOOTER.size;
    for (const g of page.filter((x) => !isFooter(x) && x.y > 30))
      expect(g.y, `"${g.text}" overlaps the footer`).toBeGreaterThan(top);
    // everything is inside the page box
    for (const g of page) {
      const w = textWidth(g.text, g.size, g.font);
      expect(g.x).toBeGreaterThanOrEqual(0);
      expect(g.x + w).toBeLessThanOrEqual(A4.width);
    }
  }
}

const profiles: [string, CompanyProfile][] = [
  ['a short profile', short],
  ['a maximum-length valid profile', maximum],
  ['a long unbroken word', unbroken],
];

describe('R16-01: the legal block is inside the page on every page of every document', () => {
  for (const [name, profile] of profiles) {
    const ctx = { company: profile, specimen: false };
    it(`${name}: invoice (one page and several), statement (several pages), delivery note`, () => {
      assertLegalBlock(pagesOf(invoicePdf(invoiceDoc(2), ctx)), profile, true);
      const longInvoice = pagesOf(invoicePdf(invoiceDoc(90), ctx));
      expect(longInvoice.length).toBeGreaterThan(1);
      assertLegalBlock(longInvoice, profile, true);
      const longStatement = pagesOf(
        statementPdf(
          'client',
          { code: 'CL-01', name: 'Client Fictif' },
          statementDoc(150),
          '2026-11-07',
          ctx,
        ),
      );
      expect(longStatement.length).toBeGreaterThan(1);
      assertLegalBlock(longStatement, profile, true);
      // the BL route prints the legal lines without the RIB
      const bl = pagesOf(
        deliveryNotePdf(note, { specimen: false, company: legalFooter({ ...profile, rib: null }) }),
      );
      assertLegalBlock(bl, profile, false);
    });
  }

  it('the maximum valid profile is accepted; an unbroken one too; a block that cannot fit is refused with its own error', () => {
    const { effectiveFrom: _from, ...input } = maximum;
    void _from;
    expect(parseCompanyProfileInput(input).ok).toBe(true);
    const { effectiveFrom: _f2, ...input2 } = unbroken;
    void _f2;
    expect(parseCompanyProfileInput(input2).ok).toBe(true);
    expect(legalBlockFits(maximum)).toBe(true);
    // beyond what the field limits allow (a profile built around the validator): refused, never clipped
    expect(legalBlockFits({ ...unbroken, address: 'W'.repeat(1200) })).toBe(false);
  });

  it('a missing profile keeps the neutral placeholder, inside the page', () => {
    const pages = pagesOf(invoicePdf(invoiceDoc(1), { company: null, specimen: false }));
    const foot = pages[0]!.filter(isFooter);
    expect(squash(foot.map((g) => g.text).join(''))).toContain(squash('Coordonnées légales à renseigner'));
  });

  it('page 1 of the three kinds is rendered to PNG under .logs/visual-checks (macOS Quick Look; skipped elsewhere)', () => {
    const dir = '.logs/visual-checks';
    mkdirSync(dir, { recursive: true });
    const ctx = { company: maximum, specimen: true };
    const files: [string, Uint8Array][] = [
      ['r16-invoice-max-profile', invoicePdf(invoiceDoc(2), ctx)],
      [
        'r16-delivery-note-max-profile',
        deliveryNotePdf(note, { specimen: true, company: legalFooter({ ...maximum, rib: null }) }),
      ],
      [
        'r16-statement-max-profile',
        statementPdf(
          'client',
          { code: 'CL-01', name: 'Client Fictif' },
          statementDoc(150),
          '2026-11-07',
          ctx,
        ),
      ],
    ];
    for (const [name, bytes] of files) writeFileSync(`${dir}/${name}.pdf`, bytes);
    if (process.platform !== 'darwin') return;
    for (const [name] of files)
      execFileSync('qlmanage', ['-t', '-s', '1400', '-o', dir, `${dir}/${name}.pdf`], { stdio: 'ignore' });
  });
});
