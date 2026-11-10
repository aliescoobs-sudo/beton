import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/**
 * R17-06: an INDEPENDENT oracle for what a PDF looks like. The documents are drawn by our own writer with our own width table; a test that
 * measures them with the same table cannot find a wrong width. This module asks poppler (`pdftotext -bbox`: the renderer's own word
 * positions, from the real Helvetica metrics) and `pdftoppm` (the pixels) instead. Nothing here imports the writer.
 * CI installs poppler-utils and sets REQUIRE_PDF_RENDERER=1 (a missing renderer then FAILS the run); on a machine without it the tests skip.
 */
export function rendererAvailable(): boolean {
  return ['pdftoppm', 'pdftotext'].every(
    (b) => spawnSync(b, ['-v'], { stdio: 'ignore' }).error === undefined,
  );
}

export interface Word {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  text: string;
}
export interface PageWords {
  width: number;
  height: number;
  words: Word[];
}

const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e === 'amp'
      ? '&'
      : e === 'lt'
        ? '<'
        : e === 'gt'
          ? '>'
          : e === 'quot'
            ? '"'
            : e === 'apos'
              ? "'"
              : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

function withFile<T>(bytes: Uint8Array, fn: (dir: string, file: string) => T): T {
  mkdirSync('.logs', { recursive: true });
  const dir = mkdtempSync(join('.logs', 'render-'));
  try {
    const file = join(dir, 'doc.pdf');
    writeFileSync(file, bytes);
    return fn(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The words of every page with the renderer's own bounding boxes, in points. */
export function wordsOf(bytes: Uint8Array): PageWords[] {
  return withFile(bytes, (_dir, file) => {
    const html = execFileSync('pdftotext', ['-bbox', file, '-'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...html.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)].map((p) => ({
      width: Number(p[1]),
      height: Number(p[2]),
      words: [
        ...(p[3] as string).matchAll(
          /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g,
        ),
      ].map((w) => ({
        xMin: Number(w[1]),
        yMin: Number(w[2]),
        xMax: Number(w[3]),
        yMax: Number(w[4]),
        text: decodeEntities(w[5] as string),
      })),
    }));
  });
}

export interface Gray {
  width: number;
  height: number;
  /** 0 black … 255 white */
  data: Uint8Array;
}

/** A minimal decoder for the 8-bit, non-interlaced grayscale / RGB PNG that pdftoppm writes. */
export function decodePng(buf: Buffer): Gray {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let i = 8;
  let width = 0;
  let height = 0;
  let channels = 1;
  const idat: Buffer[] = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const body = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8 || body[12] !== 0) throw new Error('unsupported PNG (need 8-bit, not interlaced)');
      channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 6 ? 4 : colour === 4 ? 2 : -1;
      if (channels < 0) throw new Error('unsupported PNG colour type');
    } else if (type === 'IDAT') idat.push(Buffer.from(body));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] as number;
    const line = Uint8Array.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (line[x - channels] as number) : 0;
      const b = prev[x] as number;
      const c = x >= channels ? (prev[x - channels] as number) : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = ((line[x] as number) + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = x * channels;
      out[y * width + x] =
        channels >= 3
          ? Math.round(((line[o] as number) + (line[o + 1] as number) + (line[o + 2] as number)) / 3)
          : (line[o] as number);
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Every page as pixels at `dpi` (page 1 first). */
export function pagesAsPixels(bytes: Uint8Array, dpi = 144): Gray[] {
  return withFile(bytes, (dir, file) => {
    execFileSync('pdftoppm', ['-r', String(dpi), '-gray', '-png', file, join(dir, 'p')], { stdio: 'ignore' });
    return readdirSync(dir)
      .filter((f) => /^p-\d+\.png$/.test(f))
      .sort()
      .map((f) => decodePng(readFileSync(join(dir, f))));
  });
}

/** The ink (any pixel darker than `threshold`) in the rows [y0, y1) as a column range [minX, maxX], or null when the band is empty. */
export function inkExtent(
  g: Gray,
  y0: number,
  y1: number,
  threshold = 200,
): { minX: number; maxX: number } | null {
  let minX = Infinity;
  let maxX = -1;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(g.height, Math.ceil(y1)); y++)
    for (let x = 0; x < g.width; x++)
      if ((g.data[y * g.width + x] as number) < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
  return maxX < 0 ? null : { minX, maxX };
}
