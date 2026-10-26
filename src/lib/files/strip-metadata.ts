// Removes what a photo or a scan carries beyond its picture (GPS, camera, dates, thumbnails, text chunks), without an image
// library: each format is walked segment by segment and only an allow-list is copied. A file that does not parse is refused.
// The one thing kept from a JPEG's EXIF is the orientation, rebuilt as a minimal EXIF of its own, so a phone photo still shows
// the right way up (DECISIONS 99).
import type { AllowedType } from './file-types';

export class CorruptFileError extends Error {}

const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** The orientation (1 to 8) of an EXIF segment payload (after the "Exif\0\0" header), or null. */
export function exifOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const u16 = (at: number) => (little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!);
  const u32 = (at: number) => (little ? u32le(tiff, at) : u32be(tiff, at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A minimal EXIF APP1 segment carrying only the orientation. */
function orientationSegment(orientation: number): Uint8Array {
  const body = Uint8Array.from([
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // big-endian TIFF header, IFD0 at 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // Orientation, SHORT, 1
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]);
  const length = body.length + 2;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...body]);
}

export function stripJpeg(input: Uint8Array): Uint8Array {
  if (input[0] !== 0xff || input[1] !== 0xd8) throw new CorruptFileError('not a JPEG');
  const out: Uint8Array[] = [input.subarray(0, 2)];
  let orientation: number | null = null;
  let at = 2;
  let sawScan = false;
  while (at < input.length) {
    if (input[at] !== 0xff) throw new CorruptFileError('bad marker');
    while (input[at] === 0xff && at < input.length) at += 1; // fill bytes
    const marker = input[at]!;
    at += 1;
    if (marker === 0xd9) {
      out.push(Uint8Array.from([0xff, 0xd9]));
      at = input.length;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(Uint8Array.from([0xff, marker]));
      continue;
    }
    if (at + 2 > input.length) throw new CorruptFileError('truncated');
    const length = (input[at]! << 8) | input[at + 1]!;
    if (length < 2 || at + length > input.length) throw new CorruptFileError('bad segment length');
    const segment = input.subarray(at - 2, at + length);
    const payload = input.subarray(at + 2, at + length);
    if (marker === 0xda) {
      // Scan header, then the entropy-coded data (and any later markers) are copied as they are.
      out.push(input.subarray(at - 2));
      sawScan = true;
      at = input.length;
      break;
    }
    if (marker === 0xe1 && tag(payload, 0) === 'Exif') {
      orientation ??= exifOrientation(payload.subarray(6));
    } else if (marker === 0xe0 || marker === 0xdb || marker === 0xc4 || marker === 0xdd || marker === 0xee) {
      out.push(segment); // JFIF, quantization, Huffman, restart interval, Adobe colour
    } else if (marker === 0xe2 && ascii12(payload) === 'ICC_PROFILE\0') {
      out.push(segment);
    } else if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) || marker === 0xdc) {
      out.push(segment); // frame headers
    }
    // every other APPn, COM and unknown segment is dropped
    at += length;
  }
  if (!sawScan) throw new CorruptFileError('no image data');
  if (orientation !== null && orientation !== 1) {
    // After the JFIF/first segments is fine for readers; put it right after SOI.
    out.splice(1, 0, orientationSegment(orientation));
  }
  return Buffer.concat(out);
}

const ascii12 = (b: Uint8Array) => String.fromCharCode(...b.subarray(0, 12));

const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'pHYs',
  'bKGD',
  'acTL',
  'fcTL',
  'fdAT',
]);

export function stripPng(input: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [input.subarray(0, 8)];
  let at = 8;
  let first = true;
  let ended = false;
  while (at < input.length) {
    if (at + 12 > input.length) throw new CorruptFileError('truncated chunk');
    const length = u32be(input, at);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > input.length) throw new CorruptFileError('bad chunk length');
    const type = tag(input, at + 4);
    if (first && type !== 'IHDR') throw new CorruptFileError('IHDR first');
    first = false;
    if (PNG_KEEP.has(type)) out.push(input.subarray(at, end));
    at = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new CorruptFileError('no IEND');
  return Buffer.concat(out);
}

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

export function stripWebp(input: Uint8Array): Uint8Array {
  if (input.length < 12) throw new CorruptFileError('truncated');
  const declared = u32le(input, 4) + 8;
  if (declared > input.length || declared < 12) throw new CorruptFileError('bad RIFF size');
  const out: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= declared) {
    const size = u32le(input, at + 4);
    const padded = size + (size % 2);
    if (at + 8 + padded > declared) throw new CorruptFileError('bad chunk size');
    const type = tag(input, at);
    if (WEBP_KEEP.has(type)) {
      const chunk = Buffer.from(input.subarray(at, at + 8 + padded));
      // The extended header says which metadata chunks follow: clear EXIF (0x08) and XMP (0x04).
      if (type === 'VP8X' && size >= 10) chunk[8] = chunk[8]! & ~0x0c;
      out.push(chunk);
    }
    at += 8 + padded;
  }
  const body = Buffer.concat(out);
  if (body.length === 0) throw new CorruptFileError('no image data');
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

export function stripImageMetadata(type: AllowedType, bytes: Uint8Array): Uint8Array {
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  if (type === 'image/webp') return stripWebp(bytes);
  return bytes;
}
