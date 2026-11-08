import { deflateSync } from 'node:zlib';
import { KAYAS_SIGNATURE_PDF } from './brand-logo-data';

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
const REGULAR_LOWER =
  'a556 b556 c500 d556 e556 f278 g556 h556 i222 j222 k500 l222 m833 n556 o556 p556 q556 r333 s500 t278 u556 v500 w722 x500 y500 z500';
const REGULAR_UPPER =
  'A667 B667 C722 D722 E667 F611 G778 H722 I278 J500 K667 L556 M833 N722 O778 P667 Q778 R722 S667 T611 U722 V667 W944 X667 Y667 Z611';
const BOLD_LOWER =
  'a556 b611 c556 d611 e556 f333 g611 h611 i278 j278 k556 l278 m889 n611 o611 p611 q611 r389 s556 t333 u611 v556 w778 x556 y556 z500';
const BOLD_UPPER =
  'A722 B722 C722 D722 E667 F611 G778 H722 I278 J556 K722 L611 M833 N722 O778 P667 Q778 R722 S667 T611 U722 V667 W944 X667 Y667 Z611';
const table = (s: string) => new Map(s.split(' ').map((p) => [p[0] as string, Number(p.slice(1))]));
const REGULAR = table(`${REGULAR_LOWER} ${REGULAR_UPPER}`);
const BOLD = table(`${BOLD_LOWER} ${BOLD_UPPER}`);
const PUNCT: Record<string, number> = {
  ' ': 278,
  '.': 278,
  ',': 278,
  ':': 278,
  ';': 278,
  '-': 333,
  '/': 278,
  '(': 333,
  ')': 333,
  '%': 889,
  '&': 667,
  '+': 584,
  '=': 584,
  "'": 191,
  '"': 355,
  '#': 556,
  $: 556,
  '?': 556,
  '!': 278,
  '@': 1015,
  '*': 389,
  _: 556,
  '|': 260,
  '[': 278,
  ']': 278,
};
const BASE_LETTER = (ch: string) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '')[0] ?? ch;

/** The width of a text in points at a size. Courier is exact (600 per character); Helvetica follows the standard metrics. */
export function textWidth(text: string, size: number, font: Font = 'regular'): number {
  let units = 0;
  for (const ch of text) {
    if (font === 'mono' || font === 'monoBold') {
      units += 600;
      continue;
    }
    const base = BASE_LETTER(ch);
    const letters = font === 'bold' ? BOLD : REGULAR;
    units += letters.get(base) ?? (base >= '0' && base <= '9' ? 556 : (PUNCT[ch] ?? 556));
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
    this.footerLines = [...lines];
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
        ...this.footerLines.map(
          (line, k) =>
            `0.35 g BT /F1 7 Tf ${num(A4.width / 2 - textWidth(line, 7) / 2)} ${num(46 - 9 * k)} Td <${hex(winAnsi(line))}> Tj ET`,
        ),
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
