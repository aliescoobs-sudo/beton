import { crc32 } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '@/lib/crypto/keyring';
import { sniffFileType } from './file-types';
import { exifOrientation, stripJpeg, stripPng, stripWebp } from './strip-metadata';
import { createDiskStore } from './store';
import { validateUpload } from './validate-upload';

const seg = (marker: number, payload: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);

/** An EXIF payload (little-endian TIFF) with an orientation and a GPS-looking tag, as phones write them. */
function exif(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 24 + 4 + 16);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt16LE(0x8825, 22); // GPS IFD pointer
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(40, 30);
  tiff.write('GPS-LAT-33.5N-SECRET', 40, 'ascii');
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

function jpeg(options: { orientation?: number; comment?: string } = {}): Buffer {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(options.orientation ? [seg(0xe1, exif(options.orientation))] : []),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>SECRET-XMP</x:xmpmeta>', 'latin1')),
    ...(options.comment ? [seg(0xfe, Buffer.from(options.comment))] : []),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    seg(0xc4, Buffer.alloc(20, 2)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ];
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () =>
  Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from('Author\0SECRET-AUTHOR')),
    pngChunk('eXIf', Buffer.from('SECRET-EXIF')),
    pngChunk('IDAT', Buffer.from([1, 2, 3])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

function webpChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function webp(): Buffer {
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    webpChunk('VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    webpChunk('VP8 ', Buffer.alloc(11, 5)),
    webpChunk('EXIF', Buffer.from('SECRET-EXIF')),
    webpChunk('XMP ', Buffer.from('SECRET-XMP')),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const pdf = (extra = '') =>
  Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra}>>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

describe('sniffFileType', () => {
  it('tells the allowed types from their first bytes', () => {
    expect(sniffFileType(jpeg())).toBe('image/jpeg');
    expect(sniffFileType(png())).toBe('image/png');
    expect(sniffFileType(webp())).toBe('image/webp');
    expect(sniffFileType(pdf())).toBe('application/pdf');
  });
  it.each([
    ['html', '<html><script>alert(1)</script></html>'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['gif', 'GIF89a'],
    ['zip', 'PK\u0003\u0004'],
    ['empty', ''],
  ])('refuses %s', (_n, text) => expect(sniffFileType(Buffer.from(text))).toBeNull());
});

describe('metadata stripping (AC-INT-03)', () => {
  it('a JPEG loses its GPS, XMP and comments; the orientation survives as a tiny EXIF of its own', () => {
    const input = jpeg({ orientation: 6, comment: 'SECRET-COMMENT' });
    expect(input.includes('GPS-LAT')).toBe(true);
    const out = Buffer.from(stripJpeg(input));
    for (const secret of ['GPS-LAT', 'SECRET-XMP', 'SECRET-COMMENT', 'xmpmeta'])
      expect(out.includes(secret)).toBe(false);
    expect(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    const at = out.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    expect(at).toBeGreaterThan(0);
    expect(exifOrientation(out.subarray(at + 6, at + 6 + 26))).toBe(6);
    expect(out.length).toBeLessThan(input.length);
    expect(out.subarray(out.length - 5).equals(Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]))).toBe(true);
    expect(() => stripJpeg(out)).not.toThrow();
  });

  it('a JPEG without a turned orientation carries no EXIF at all', () => {
    const out = Buffer.from(stripJpeg(jpeg({ orientation: 1 })));
    expect(out.includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(stripJpeg(jpeg())).includes(Buffer.from('Exif'))).toBe(false);
  });

  it('a PNG keeps its image chunks and loses text and EXIF chunks', () => {
    const out = Buffer.from(stripPng(png()));
    expect(out.includes('SECRET')).toBe(false);
    expect(out.includes('IDAT')).toBe(true);
    expect(out.includes('IEND')).toBe(true);
  });

  it('a WebP loses EXIF and XMP chunks and the flags that announce them, with a right RIFF size', () => {
    const out = Buffer.from(stripWebp(webp()));
    expect(out.includes('SECRET')).toBe(false);
    expect(out.readUInt32LE(4) + 8).toBe(out.length);
    const flags = out[out.indexOf(Buffer.from('VP8X')) + 8]!;
    expect(flags & 0x0c).toBe(0);
  });

  it.each([
    [
      'jpeg without scan',
      () => stripJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.alloc(14))])),
    ],
    ['jpeg truncated segment', () => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 1]))],
    ['png without IEND', () => stripPng(png().subarray(0, png().length - 12))],
    [
      'png bad length',
      () => stripPng(Buffer.concat([PNG_SIG, Buffer.from([0xff, 0xff, 0xff, 0xff, 73, 72, 68, 82])])),
    ],
    [
      'webp bad riff size',
      () =>
        stripWebp(Buffer.concat([Buffer.from('RIFF'), Buffer.from([255, 255, 0, 0]), Buffer.from('WEBP')])),
    ],
  ])('refuses a file that does not parse (%s)', (_n, run) => expect(run).toThrow());
});

describe('validateUpload (AC-INT-03)', () => {
  const max = 1_000_000;
  it('accepts each allowed type, stripped', () => {
    for (const [type, bytes] of [
      ['image/jpeg', jpeg({ orientation: 3 })],
      ['image/png', png()],
      ['image/webp', webp()],
      ['application/pdf', pdf()],
    ] as const) {
      const r = validateUpload({ declaredType: type, bytes, maxBytes: max });
      expect(r.ok, type).toBe(true);
      if (r.ok) expect(Buffer.from(r.value.bytes).includes('SECRET')).toBe(false);
    }
  });
  it('accepts a declared type with parameters and capitals', () => {
    expect(
      validateUpload({ declaredType: 'IMAGE/PNG; charset=binary', bytes: png(), maxBytes: max }).ok,
    ).toBe(true);
  });
  it('refuses empty, too large, a type that is not allowed, and a type that lies', () => {
    expect(validateUpload({ declaredType: 'image/png', bytes: Buffer.alloc(0), maxBytes: max })).toEqual({
      ok: false,
      error: 'EMPTY',
    });
    expect(validateUpload({ declaredType: 'image/png', bytes: png(), maxBytes: 10 })).toEqual({
      ok: false,
      error: 'TOO_LARGE',
    });
    expect(validateUpload({ declaredType: 'text/html', bytes: png(), maxBytes: max })).toEqual({
      ok: false,
      error: 'TYPE_NOT_ALLOWED',
    });
    expect(
      validateUpload({ declaredType: 'image/png', bytes: Buffer.from('<html>'), maxBytes: max }),
    ).toEqual({
      ok: false,
      error: 'TYPE_NOT_ALLOWED',
    });
    expect(validateUpload({ declaredType: 'image/png', bytes: jpeg(), maxBytes: max })).toEqual({
      ok: false,
      error: 'TYPE_MISMATCH',
    });
    expect(validateUpload({ declaredType: 'application/pdf', bytes: png(), maxBytes: max })).toEqual({
      ok: false,
      error: 'TYPE_MISMATCH',
    });
  });
  it('refuses a PDF that acts when opened, also with an escaped name, and a truncated one', () => {
    for (const extra of [
      '/OpenAction 2 0 R ',
      '/JavaScript (x) ',
      '/J#61vaScript (x) ',
      '/Launch ',
      '/AA << /JS (x) >> ',
    ]) {
      expect(validateUpload({ declaredType: 'application/pdf', bytes: pdf(extra), maxBytes: max })).toEqual({
        ok: false,
        error: 'ACTIVE_CONTENT',
      });
    }
    expect(
      validateUpload({
        declaredType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 no end'),
        maxBytes: max,
      }),
    ).toEqual({
      ok: false,
      error: 'CORRUPT',
    });
  });
  it('does not mistake a harmless name for an active one', () => {
    expect(
      validateUpload({ declaredType: 'application/pdf', bytes: pdf('/JSON 1 '), maxBytes: max }).ok,
    ).toBe(true);
  });
  it('refuses an image that does not parse', () => {
    expect(
      validateUpload({
        declaredType: 'image/jpeg',
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00]),
        maxBytes: max,
      }),
    ).toEqual({ ok: false, error: 'CORRUPT' });
  });
});

describe('the disk store', () => {
  const dirs: string[] = [];
  const make = async (spec = `k1:${Buffer.alloc(32, 1).toString('base64')}`) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bb-files-'));
    dirs.push(dir);
    return { dir, store: createDiskStore(dir, parseKeyring(spec)) };
  };
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
  const id = '0192a000-0000-7000-8000-000000000001';

  it('stores sealed content that reads back, with owner-only permissions', async () => {
    const { dir, store } = await make();
    await store.put(id, jpeg());
    expect((await store.get(id)).equals(jpeg())).toBe(true);
    const file = path.join(dir, id.slice(0, 2), `${id}.bin`);
    expect((await readFile(file)).includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readdir(path.dirname(file))).toEqual([`${id}.bin`]);
  });

  it('a blob copied under another id does not open', async () => {
    const { dir, store } = await make();
    await store.put(id, png());
    const other = '0192a000-0000-7000-8000-000000000002';
    const from = path.join(dir, id.slice(0, 2), `${id}.bin`);
    await writeFile(path.join(dir, other.slice(0, 2), `${other}.bin`), await readFile(from));
    await expect(store.get(other)).rejects.toThrow();
  });

  it('refuses a path-like id, and never overwrites silently an altered file', async () => {
    const { dir, store } = await make();
    await expect(store.put('../../etc/passwd', png())).rejects.toThrow('Invalid file id');
    await expect(store.get('..%2f..%2fx')).rejects.toThrow('Invalid file id');
    await store.put(id, png());
    const file = path.join(dir, id.slice(0, 2), `${id}.bin`);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(file, bytes);
    await expect(store.get(id)).rejects.toThrow();
  });

  it('rotates to the current key and keeps the content', async () => {
    const k1 = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
    const k2 = `k2:${Buffer.alloc(32, 2).toString('base64')}`;
    const { dir, store } = await make(k1);
    await store.put(id, pdf());
    const rotated = createDiskStore(dir, parseKeyring(`${k2},${k1}`));
    expect(await rotated.ids()).toEqual([id]);
    expect(await rotated.onRetiredKey(id)).toBe(true);
    expect(await rotated.rotate(id)).toBe(true);
    expect(await rotated.onRetiredKey(id)).toBe(false);
    expect(await rotated.rotate(id)).toBe(false);
    expect((await createDiskStore(dir, parseKeyring(k2)).get(id)).equals(pdf())).toBe(true);
  });
});
