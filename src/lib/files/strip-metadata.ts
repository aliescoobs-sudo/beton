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

/**
 * R18-12: the whole JPEG is walked MARKER BY MARKER through the end-of-image marker, not just up to the first scan. A progressive or
 * multi-scan file has segments (APPn, COM, anything unknown) between its scans: they are dropped like the ones before the first scan. The
 * entropy-coded data of a scan is copied byte for byte up to the next real marker (an `FF 00` is a stuffed data byte and `FF D0..D7` a
 * restart marker, both part of the data). The file ends at its first EOI: every byte after it (a payload appended to the picture) is dropped.
 * A file with no EOI, no scan, or a marker structure that does not parse is refused.
 */
export function stripJpeg(input: Uint8Array): Uint8Array {
  if (input[0] !== 0xff || input[1] !== 0xd8) throw new CorruptFileError('not a JPEG');
  const out: Uint8Array[] = [input.subarray(0, 2)];
  let orientation: number | null = null;
  let at = 2;
  let scans = 0;
  let ended = false;
  while (at < input.length) {
    if (input[at] !== 0xff) throw new CorruptFileError('bad marker');
    while (input[at] === 0xff && at < input.length) at += 1; // fill bytes
    const marker = input[at]!;
    at += 1;
    if (marker === 0x00) throw new CorruptFileError('bad marker');
    if (marker === 0xd9) {
      out.push(Uint8Array.from([0xff, 0xd9]));
      ended = true;
      break; // everything after the end of image is dropped
    }
    if (marker === 0xd8) throw new CorruptFileError('a second start of image');
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
      // The scan header is kept; the entropy-coded data after it runs to the next marker that is not a stuffed byte or a restart marker.
      out.push(segment);
      scans += 1;
      let end = at + length;
      for (;;) {
        if (end >= input.length) throw new CorruptFileError('truncated scan');
        if (input[end] !== 0xff) {
          end += 1;
          continue;
        }
        let next = end + 1;
        while (input[next] === 0xff) next += 1; // fill bytes before a marker
        const m = input[next];
        if (m === undefined) throw new CorruptFileError('truncated scan');
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
          end = next + 1; // stuffed data byte or restart marker: still the scan
          continue;
        }
        break;
      }
      out.push(input.subarray(at + length, end));
      at = end;
      continue;
    }
    if (marker === 0xe1 && scans === 0 && tag(payload, 0) === 'Exif') {
      orientation ??= exifOrientation(payload.subarray(6));
    } else if (marker === 0xe0) {
      // R19-11: the JFIF header is REBUILT (version, units and density kept; the thumbnail dimensions zeroed and the thumbnail bytes dropped). A JFXX extension
      // (an embedded thumbnail that is a JPEG of its own, with its own EXIF) and any other APP0 are dropped.
      const jfif = jfifSegment(payload);
      if (jfif) out.push(jfif);
    } else if (marker === 0xee) {
      // Adobe colour transform: only the exact 12-byte form (identifier, version, two flags, transform); anything longer could hold text
      if (payload.length === 12 && tag(payload, 0) === 'Adob' && payload[4] === 0x65) out.push(segment);
    } else if (marker === 0xdb || marker === 0xc4 || marker === 0xdd) {
      out.push(segment); // quantization, Huffman, restart interval
    } else if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) || marker === 0xdc) {
      out.push(segment); // frame headers (and the number-of-lines definition)
    }
    // every other APPn (an Exif after the first scan included; an ICC profile, whose description and creator are text, R19-11; the multi-picture index), COM and unknown segment is dropped
    at += length;
  }
  if (scans === 0) throw new CorruptFileError('no image data');
  if (!ended) throw new CorruptFileError('no end of image');
  if (orientation !== null && orientation !== 1) {
    // After the JFIF/first segments is fine for readers; put it right after SOI.
    out.splice(1, 0, orientationSegment(orientation));
  }
  return Buffer.concat(out);
}

/** A clean JFIF APP0 from an original one: "JFIF\0", version, units, densities, and a 0 x 0 thumbnail. Null when the segment is not a JFIF header. */
function jfifSegment(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 14 || tag(payload, 0) !== 'JFIF' || payload[4] !== 0) return null;
  const body = Uint8Array.from([
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // "JFIF\0"
    payload[5]!,
    payload[6]!, // version
    payload[7]!, // units
    payload[8]!,
    payload[9]!,
    payload[10]!,
    payload[11]!, // X and Y density
    0x00,
    0x00, // no thumbnail
  ]);
  return Uint8Array.from([0xff, 0xe0, 0x00, body.length + 2, ...body]);
}

const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
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

// R19-11: no ICCP (a profile's description and creator are text); an animation frame (ANMF) is rebuilt from its header and its picture sub-chunks only
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const WEBP_FRAME_KEEP = new Set(['VP8 ', 'VP8L', 'ALPH']);

/** An animation frame: its 16-byte header, then only the picture sub-chunks (alpha, lossy, lossless); every other sub-chunk is dropped. */
function rebuildFrame(payload: Uint8Array): Buffer {
  if (payload.length < 16) throw new CorruptFileError('bad frame');
  const kept: Buffer[] = [Buffer.from(payload.subarray(0, 16))];
  let at = 16;
  while (at + 8 <= payload.length) {
    const size = u32le(payload, at + 4);
    const padded = size + (size % 2);
    if (at + 8 + padded > payload.length) throw new CorruptFileError('bad frame chunk');
    if (WEBP_FRAME_KEEP.has(tag(payload, at))) kept.push(Buffer.from(payload.subarray(at, at + 8 + padded)));
    at += 8 + padded;
  }
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(8);
  head.write('ANMF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]); // sizes are even: every kept sub-chunk is padded
}

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
      let chunk: Buffer = Buffer.from(input.subarray(at, at + 8 + padded));
      // The extended header says which metadata chunks follow: clear the ICC profile (0x20), EXIF (0x08) and XMP (0x04) flags.
      if (type === 'VP8X' && size >= 10) chunk[8] = chunk[8]! & ~0x2c;
      if (type === 'ANMF') chunk = rebuildFrame(input.subarray(at + 8, at + 8 + size));
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
