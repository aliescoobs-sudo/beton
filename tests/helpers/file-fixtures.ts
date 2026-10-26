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
