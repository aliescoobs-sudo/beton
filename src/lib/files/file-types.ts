// What a stored document may be: images and PDF only, told by their first bytes, never by the name or the declared type alone.
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

export const isAllowedType = (value: string): value is AllowedType =>
  (ALLOWED_TYPES as readonly string[]).includes(value);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** The type the content itself shows (magic bytes), or null when it is none of the allowed ones. */
export function sniffFileType(bytes: Uint8Array): AllowedType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b))
    return 'image/png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return 'image/webp';
  if (ascii(bytes, 0, Math.min(bytes.length, 1024)).includes('%PDF-')) return 'application/pdf';
  return null;
}

export const EXTENSIONS: Record<AllowedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
