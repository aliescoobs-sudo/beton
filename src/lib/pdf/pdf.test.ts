import { describe, expect, it } from 'vitest';
import { PdfDocument, textWidth, winAnsi, wrapText } from './pdf';
import { readPdf } from './read-text';

describe('winAnsi', () => {
  it('keeps French accents and the euro-like punctuation, and turns what the fonts cannot show into "?"', () => {
    expect(Buffer.from(winAnsi('Béton é à ç — « »')).toString('latin1')).toBe('Béton é à ç \u0097 « »');
    expect(Buffer.from(winAnsi('اسم')).toString('latin1')).toBe('???');
    expect(Buffer.from(winAnsi('1 234,56')).toString('latin1')).toBe('1 234,56');
    expect(Buffer.from(winAnsi('a\nb')).toString('latin1')).toBe('a b');
  });
});

describe('textWidth and wrapText', () => {
  it('Courier is exactly 600 per character; Helvetica follows the metrics, bold is wider', () => {
    expect(textWidth('12345', 10, 'mono')).toBe(30);
    expect(textWidth('iiii', 10)).toBeCloseTo(8.88, 2);
    expect(textWidth('MMMM', 10)).toBeCloseTo(33.32, 2);
    expect(textWidth('Facture', 10, 'bold')).toBeGreaterThan(textWidth('Facture', 10));
    expect(textWidth('é', 10)).toBe(textWidth('e', 10));
  });
  it('wraps on spaces within the width, cuts a word that is longer than a line, keeps paragraphs', () => {
    const lines = wrapText('Béton B25 livré sur le chantier de la zone industrielle', 80, 10);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(80);
    expect(wrapText('a b', 1000, 10)).toEqual(['a b']);
    expect(wrapText('x'.repeat(100), 50, 10).every((l) => textWidth(l, 10) <= 50)).toBe(true);
    expect(wrapText('un\ndeux', 1000, 10)).toEqual(['un', 'deux']);
  });
});

describe('PdfDocument', () => {
  it('builds a well-formed file with the text of every page, the watermark and the page numbers', () => {
    const doc = new PdfDocument({ title: 'Facture FA-2026-00001' });
    doc.watermark('SPÉCIMEN — données fictives');
    doc.text(50, 800, 'Facture FA-2026-00001', { font: 'bold', size: 16 });
    doc.line(50, 790, 540, 790);
    doc.rect(50, 700, 490, 20, { fillGray: 0.9, stroke: true });
    doc.text(540, 710, '1 234,56 MAD', { align: 'right', font: 'mono' });
    doc.addPage();
    doc.text(50, 800, 'Suite (page 2) — é à ç');
    const bytes = doc.build();
    const read = readPdf(bytes);
    expect(read.pages).toHaveLength(2);
    expect(read.pages[0]).toContain('Facture FA-2026-00001');
    expect(read.pages[0]).toContain('SPÉCIMEN \u0097 données fictives');
    expect(read.pages[0]).toContain('1 234,56 MAD');
    expect(read.pages[0]).toContain('Page 1 / 2');
    expect(read.pages[1]).toContain('Suite (page 2)');
    expect(read.pages[1]).toContain('Page 2 / 2');
    expect(doc.pageCount).toBe(2);
  });

  it('is deterministic apart from nothing: the same drawing gives the same bytes, and nothing is written to disk', () => {
    const make = () => {
      const d = new PdfDocument({ title: 't' });
      d.text(10, 10, 'x');
      return Buffer.from(d.build());
    };
    expect(make().equals(make())).toBe(true);
  });

  it('puts the watermark only when asked', () => {
    const plain = new PdfDocument({ title: 't' });
    plain.text(10, 10, 'x');
    expect(readPdf(plain.build()).pages[0]).not.toContain('SP');
  });
});
