import { deflateSync } from 'node:zlib';
import { KAYAS_SIGNATURE_PDF } from './brand-logo-data';
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS } from './helvetica-metrics';

// A small PDF writer: A4 pages, the standard fonts (Helvetica, Courier, bold of each) in WinAnsi, text, lines, rectangles and a
// diagonal watermark. No dependency, nothing written to disk: `build()` returns the bytes, the route streams them. Characters
// outside WinAnsi (Arabic, for instance) are replaced by "?": the documents are French legal documents (DECISIONS 111).

export const A4 = { width: 595.28, height: 841.89 } as const;

/** KAYAS brand colours as PDF RGB (0 to 1). Forêt #01592B, Citron #9ADA02, Graphite #292929. */
export type Rgb = readonly [number, number, number];
const rgb255 = (r: number, g: number, b: number): Rgb => [r / 255, g / 255, b / 255];
export const BRAND = {
  forest: rgb255(1, 89, 43),
  citron: rgb255(154, 218, 2),
  graphite: rgb255(41, 41, 41),
  white: [1, 1, 1] as Rgb,
} as const;

export type Font = 'regular' | 'bold' | 'mono' | 'monoBold';
const FONT_NAME: Record<Font, string> = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  mono: 'Courier',
  monoBold: 'Courier-Bold',
};
const FONT_KEY: Record<Font, string> = { regular: 'F1', bold: 'F2', mono: 'F3', monoBold: 'F4' };

const SPECIAL: Record<number, number> = {
  0x20ac: 0x80,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x2026: 0x85,
  0x0152: 0x8c,
  0x0153: 0x9c,
  0x202f: 0x20,
  0x2009: 0x20,
  0x00a0: 0x20,
};

/** The WinAnsi (Windows-1252) bytes of a text; what the font cannot show becomes "?". */
export function winAnsi(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (SPECIAL[code] !== undefined) out.push(SPECIAL[code] as number);
    else if (code === 0x0a || code === 0x0d || code === 0x09) out.push(0x20);
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff)) out.push(code);
    else out.push(0x3f);
  }
  return Uint8Array.from(out);
}

// Helvetica widths in thousandths of an em (the standard metrics); an accented letter takes its base letter's width.
/**
 * The width of a text in points at a size. Courier is exact (600 per character); Helvetica uses the complete Adobe metrics of the byte each
 * character becomes in WinAnsi (the width of what is DRAWN, so a character that is replaced by "?" is measured as "?"). No glyph falls back to
 * a default: a byte without a width is a bug and throws.
 */
export function textWidth(text: string, size: number, font: Font = 'regular'): number {
  if (font === 'mono' || font === 'monoBold') return (Array.from(text).length * 600 * size) / 1000;
  const widths = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const byte of winAnsi(text)) {
    const w = widths.get(byte);
    if (w === undefined) throw new Error(`pdf: no Helvetica width for byte 0x${byte.toString(16)}`);
    units += w;
  }
  return (units * size) / 1000;
}

export interface TextOptions {
  size?: number;
  font?: Font;
  align?: 'left' | 'right' | 'center';
  /** Gray level, 0 black to 1 white. */
  gray?: number;
  /** A brand colour; wins over `gray`. */
  color?: Rgb;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const num = (n: number) => (Math.round(n * 100) / 100).toString();
// Five decimals: the brand colours must be exact (Forêt #01592B is 0.00392 0.34902 0.16863), not rounded to hundredths.
const rgbOps = (c: Rgb) => c.map((v) => v.toFixed(5)).join(' ');

/** Breaks a text into lines that fit `maxWidth` points, on spaces; a word longer than a line is cut. */
export function wrapText(text: string, maxWidth: number, size: number, font: Font = 'regular'): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (textWidth(trial, size, font) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (textWidth(rest, size, font) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut), size, font) > maxWidth) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** The legal footer box: inside the left and right margins, 7 pt, stacked upwards from just above the page number. */
export const FOOTER = { margin: 40, size: 7, leading: 8.5, baseline: 36, maxLines: 10 } as const;

/** The footer lines as they are printed: every line wrapped inside the margins, a word longer than a line force-broken. */
export function wrapFooter(lines: readonly string[]): string[] {
  const width = A4.width - 2 * FOOTER.margin;
  return lines.flatMap((line) => wrapText(line, width, FOOTER.size)).filter((l) => l.length > 0);
}

export class PdfDocument {
  private readonly pages: string[][] = [];
  private watermarkText: string | null = null;
  private footerLines: string[] = [];
  private readonly title: string;

  constructor(options: { title: string }) {
    this.title = options.title;
    this.addPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
  }

  private ops(): string[] {
    return this.pages[this.pages.length - 1] as string[];
  }

  /** Text at (x, y) from the bottom-left of the page; `right` and `center` take x as the right edge or the middle. */
  text(x: number, y: number, text: string, options: TextOptions = {}): void {
    const size = options.size ?? 10;
    const font = options.font ?? 'regular';
    const width = textWidth(text, size, font);
    const at = options.align === 'right' ? x - width : options.align === 'center' ? x - width / 2 : x;
    const fill = options.color ? `${rgbOps(options.color)} rg` : `${num(options.gray ?? 0)} g`;
    this.ops().push(
      `${fill} BT /${FONT_KEY[font]} ${num(size)} Tf ${num(at)} ${num(y)} Td <${hex(winAnsi(text))}> Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color?: Rgb): void {
    this.ops().push(
      `${color ? `${rgbOps(color)} RG` : '0 G'} ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`,
    );
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    options: { fillGray?: number; fillRgb?: Rgb; stroke?: boolean } = {},
  ): void {
    const fill = options.fillGray !== undefined || options.fillRgb !== undefined;
    this.ops().push(
      `${options.fillRgb ? `${rgbOps(options.fillRgb)} rg ` : options.fillGray !== undefined ? `${num(options.fillGray)} g ` : ''}${options.stroke ? '0 G 0.5 w ' : ''}${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${
        fill && options.stroke ? 'B' : fill ? 'f' : 'S'
      }`,
    );
  }

  /**
   * The KAYAS colour signature as VECTOR paths (the SVG's own contours, flat Forêt and Citron fills), never stretched: `width` is given and
   * the height follows the file's ratio, so the header is sharp at any resolution. (x, y) is the bottom-left corner. Returns the height in points.
   */
  logo(x: number, y: number, width: number): number {
    const { width: w, height: h, paths } = KAYAS_SIGNATURE_PDF;
    const k = width / w;
    const height = h * k;
    // The SVG is y-down: a flipping matrix puts its origin at the top-left corner of the box.
    const ops = [`q ${num(k)} 0 0 ${num(-k)} ${num(x)} ${num(y + height)} cm`];
    for (const p of paths) ops.push(`${rgbOps(p.fill)} rg ${p.ops} ${p.evenOdd ? 'f*' : 'f'}`);
    ops.push('Q');
    this.ops().push(ops.join('\n'));
    return height;
  }

  /** Legal lines printed at the foot of every page (above the page number), from the owner-filled company profile. */
  footer(lines: readonly string[]): void {
    this.footerLines = wrapFooter(lines);
  }

  /** The y (from the page bottom) of the top of the footer box: page content must stay above it. 0 without a footer. */
  get footerTop(): number {
    const n = this.footerLines.length;
    return n === 0 ? 0 : FOOTER.baseline + (n - 1) * FOOTER.leading + FOOTER.size + 2;
  }

  /** A pale diagonal text across every page (drawn under the page's own content), for the pilot's documents. */
  watermark(text: string): void {
    this.watermarkText = text;
  }

  /** The document as bytes: PDF 1.4, deflated content streams, nothing written anywhere. */
  build(): Uint8Array {
    const total = this.pages.length;
    const objects: Buffer[] = [];
    const add = (body: string | Buffer): number => {
      objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
      return objects.length;
    };
    // 1 catalog, 2 pages (filled in below), 3-6 fonts, 7 info
    add('');
    add('');
    for (const font of ['regular', 'bold', 'mono', 'monoBold'] as const)
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME[font]} /Encoding /WinAnsiEncoding >>`);
    add(`<< /Title <${hex(winAnsi(this.title))}> /Producer (KAYAS) >>`);
    const kids: number[] = [];
    for (const [n, ops] of this.pages.entries()) {
      const content = [
        ...(this.watermarkText
          ? [
              `0.88 g q 0.7071 0.7071 -0.7071 0.7071 150 250 cm BT /F2 40 Tf 0 0 Td <${hex(winAnsi(this.watermarkText))}> Tj ET Q`,
            ]
          : []),
        ...ops,
        ...this.footerLines.map((line, k) => {
          const x = Math.max(FOOTER.margin, A4.width / 2 - textWidth(line, FOOTER.size) / 2);
          const y = FOOTER.baseline + (this.footerLines.length - 1 - k) * FOOTER.leading;
          return `0.35 g BT /F1 ${FOOTER.size} Tf ${num(x)} ${num(y)} Td <${hex(winAnsi(line))}> Tj ET`;
        }),
        // Page number, last line of every page
        `0.4 g BT /F1 8 Tf ${num(A4.width / 2 - 20)} 24 Td <${hex(winAnsi(`Page ${n + 1} / ${total}`))}> Tj ET`,
      ].join('\n');
      const stream = deflateSync(Buffer.from(content, 'latin1'));
      const contentId = add(
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
          stream,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      );
      kids.push(
        add(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      );
    }
    objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
    objects[1] = Buffer.from(
      `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
      'latin1',
    );

    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1')];
    const offsets: number[] = [];
    let at = parts[0]?.length ?? 0;
    for (const [i, body] of objects.entries()) {
      offsets.push(at);
      const chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
        body,
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      parts.push(chunk);
      at += chunk.length;
    }
    const xref = [
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
      ...offsets.map((o) => `${o.toString().padStart(10, '0')} 00000 n \n`),
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${at}\n%%EOF\n`,
    ].join('');
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}
