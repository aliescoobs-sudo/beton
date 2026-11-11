import { crc32 } from 'node:zlib';

const seg = (marker: number, payload: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);

/** A JPEG that looks like a phone photo: an EXIF block with a GPS-looking string, XMP, a comment, then the picture. */
export function jpegWithGps(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0\0\0\0\0GPS-LAT-33.5N-SECRET', 'latin1')),
    seg(0xfe, Buffer.from('SECRET-COMMENT')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

/**
 * R18-12: a JPEG with TWO scans, restart markers and stuffed bytes in the entropy data, metadata canaries BETWEEN the scans and AFTER the last
 * scan, and (optionally) a payload appended after the end-of-image marker. Every canary is a synthetic string.
 */
export const JPEG_CANARIES = [
  'CANARY-BETWEEN-APP1-GPS',
  'CANARY-BETWEEN-COM',
  'CANARY-BETWEEN-APP13',
  'CANARY-AFTER-SCAN-XMP',
  'CANARY-AFTER-SCAN-COM',
  'CANARY-TRAILING-PAYLOAD',
] as const;
export function jpegMultiScan(opts: { trailing?: boolean; lateOrientation?: number } = {}): Buffer {
  const lateExif = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from([
      0x4d,
      0x4d,
      0,
      0x2a,
      0,
      0,
      0,
      8,
      0,
      1,
      0x01,
      0x12,
      0,
      3,
      0,
      0,
      0,
      1,
      0,
      opts.lateOrientation ?? 1,
      0,
      0,
      0,
      0,
      0,
      0,
    ]),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc2, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), // progressive frame
    seg(0xc4, Buffer.alloc(20, 2)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), // data with a stuffed 0xFF and a restart marker
    seg(0xe1, Buffer.from(`Exif\0\0MM\0*\0\0\0\x08\0\0\0\0\0\0${JPEG_CANARIES[0]}`, 'latin1')),
    seg(0xfe, Buffer.from(JPEG_CANARIES[1])),
    seg(0xed, Buffer.from(`Photoshop 3.0\0${JPEG_CANARIES[2]}`, 'latin1')),
    seg(0xc4, Buffer.alloc(20, 3)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x78, 0x9a, 0xbc]),
    seg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${JPEG_CANARIES[3]}`, 'latin1')),
    seg(0xe1, lateExif),
    seg(0xfe, Buffer.from(JPEG_CANARIES[4])),
    Buffer.from([0xff, 0xd9]),
    ...(opts.trailing ? [Buffer.from(`${JPEG_CANARIES[5]}\xff\xd8 more bytes`, 'latin1')] : []),
  ]);
}

const pngChunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** A PNG with a text chunk (author) and `padding` bytes of picture data, to test the size limit. */
export function pngWithText(padding = 3): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from('Author\0SECRET-AUTHOR')),
    pngChunk('IDAT', Buffer.alloc(padding, 7)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const simplePdf = (extra = '') =>
  Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra}>>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

/** R19-11: a JPEG whose JFIF header carries a thumbnail, with a JFXX thumbnail JPEG that has its own EXIF/GPS, an ICC profile text, a multi-picture index. */
export const NESTED_CANARIES = [
  'CANARY-NESTED-JFIF-THUMB',
  'CANARY-NESTED-JFXX-EXIF-GPS',
  'CANARY-NESTED-ICC-DESC',
  'CANARY-NESTED-MPF',
] as const;
export function jpegNestedMetadata(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(
      0xe0,
      Buffer.concat([
        Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\x02\x02', 'latin1'),
        Buffer.from(NESTED_CANARIES[0]),
      ]),
    ),
    seg(
      0xe0,
      Buffer.concat([Buffer.from('JFXX\0\x10', 'latin1'), jpegWithGps(), Buffer.from(NESTED_CANARIES[1])]),
    ),
    seg(
      0xe2,
      Buffer.concat([
        Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'),
        Buffer.from(`desc ${NESTED_CANARIES[2]}`),
      ]),
    ),
    seg(0xe2, Buffer.concat([Buffer.from('MPF\0', 'latin1'), Buffer.from(NESTED_CANARIES[3])])),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}
