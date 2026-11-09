import { A4, BRAND, type Font, PdfDocument, type Rgb, textWidth, wrapText } from './pdf';

const MARGIN = 40;
const MIN_BOTTOM = 64; // room for the page number when there is no footer
const LOGO_WIDTH = 150;

export interface Column {
  header: string;
  /** Points; the column with `width` 0 takes what is left. */
  width: number;
  align?: 'left' | 'right';
  font?: Font;
}

/** A top-down cursor over a `PdfDocument`: blocks of text, key/value pairs and tables that break onto a new page. */
export class PdfLayout {
  readonly doc: PdfDocument;
  y: number = A4.height - MARGIN;
  /** Content never goes below this: it clears the legal footer box, whatever its height. */
  private bottom: number = MIN_BOTTOM;

  /**
   * KAYAS header on the first page: the colour signature top left (never stretched) and a thin Citron rule under it. `footer` is the
   * legal line(s) built from the owner-filled company profile (raison sociale, ICE, RC, address); printed on every page.
   */
  constructor(title: string, options: { watermark?: string | null; footer?: readonly string[] } = {}) {
    this.doc = new PdfDocument({ title });
    if (options.watermark) this.doc.watermark(options.watermark);
    if (options.footer?.length) this.doc.footer(options.footer);
    this.bottom = Math.max(MIN_BOTTOM, this.doc.footerTop + 8);
    this.doc.logo(MARGIN, this.y - 33, LOGO_WIDTH);
    this.y -= 33 + 7;
    this.doc.line(MARGIN, this.y, MARGIN + this.width, this.y, 1.5, BRAND.citron);
    this.y -= 12;
  }

  get width(): number {
    return A4.width - 2 * MARGIN;
  }

  private room(height: number): void {
    if (this.y - height < this.bottom) {
      this.doc.addPage();
      this.y = A4.height - MARGIN;
    }
  }

  gap(points = 8): void {
    this.y -= points;
  }

  /** Wrapped lines at the left margin. */
  paragraph(text: string, options: { size?: number; font?: Font; gray?: number; color?: Rgb } = {}): void {
    const size = options.size ?? 10;
    for (const line of wrapText(text, this.width, size, options.font)) {
      this.room(size + 3);
      this.y -= size + 3;
      this.doc.text(MARGIN, this.y, line, options);
    }
  }

  title(text: string): void {
    this.paragraph(text, { size: 18, font: 'bold', color: BRAND.forest });
    this.gap(4);
  }

  rule(): void {
    this.room(6);
    this.y -= 4;
    this.doc.line(MARGIN, this.y, MARGIN + this.width, this.y);
    this.y -= 2;
  }

  /** "Label  value" lines, label in bold on the left. */
  pairs(rows: readonly (readonly [string, string])[], labelWidth = 130): void {
    for (const [label, value] of rows) {
      const lines = wrapText(value, this.width - labelWidth, 10);
      this.room(13 * lines.length);
      this.y -= 13;
      this.doc.text(MARGIN, this.y, label, { font: 'bold' });
      lines.forEach((line, i) => {
        if (i > 0) this.y -= 13;
        this.doc.text(MARGIN + labelWidth, this.y, line);
      });
    }
  }

  /** Right-aligned "label  value" totals under a table. */
  totals(rows: readonly (readonly [string, string])[], options: { boldLast?: boolean } = {}): void {
    rows.forEach(([label, value], i) => {
      const font: Font = options.boldLast && i === rows.length - 1 ? 'bold' : 'regular';
      this.room(14);
      this.y -= 14;
      this.doc.text(MARGIN + this.width - 110, this.y, label, { align: 'right', font });
      this.doc.text(MARGIN + this.width, this.y, value, { align: 'right', font });
    });
  }

  table(columns: readonly Column[], rows: readonly (readonly string[])[]): void {
    const fixed = columns.reduce((n, c) => n + c.width, 0);
    // The column declared with width 0 takes what is left (the first one when several: the invoice's Désignation, the statement's Solde).
    const flexible = columns.findIndex((c) => c.width === 0);
    const widths = columns.map((c, i) => (i === flexible ? this.width - fixed : c.width));
    const edges = widths.reduce<number[]>(
      (acc, w) => [...acc, (acc[acc.length - 1] as number) + w],
      [MARGIN],
    );
    const head = () => {
      this.room(18);
      this.y -= 14;
      this.doc.rect(MARGIN, this.y - 4, this.width, 16, { fillRgb: BRAND.forest });
      columns.forEach((c, i) => this.cell(c, i, edges, c.header, 'bold', BRAND.white));
      this.y -= 4;
    };
    head();
    for (const row of rows) {
      const wrapped = row.map((cell, i) =>
        wrapText(cell, (widths[i] as number) - 6, 9, columns[i]?.font ?? 'regular'),
      );
      const height = Math.max(...wrapped.map((l) => l.length)) * 11 + 3;
      if (this.y - height < this.bottom) {
        this.doc.addPage();
        this.y = A4.height - MARGIN;
        head();
      }
      const top = this.y;
      wrapped.forEach((lines, i) =>
        lines.forEach((line, n) => {
          this.y = top - 11 * (n + 1);
          this.cell(columns[i] as Column, i, edges, line, columns[i]?.font ?? 'regular');
        }),
      );
      this.y = top - height;
    }
    this.doc.line(MARGIN, this.y, MARGIN + this.width, this.y);
    this.y -= 4;
  }

  private cell(c: Column, i: number, edges: readonly number[], text: string, font: Font, color?: Rgb): void {
    const left = edges[i] as number;
    const right = edges[i + 1] as number;
    if (c.align === 'right')
      this.doc.text(right - 3, this.y, text, { size: 9, font, align: 'right', ...(color ? { color } : {}) });
    else this.doc.text(left + 3, this.y, text, { size: 9, font, ...(color ? { color } : {}) });
  }

  build(): Uint8Array {
    return this.doc.build();
  }
}

export { textWidth };
