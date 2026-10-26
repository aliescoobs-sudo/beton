import { err, ok, type Result } from '@/lib/result';
import { type AllowedType, isAllowedType, sniffFileType } from './file-types';
import { CorruptFileError, stripImageMetadata } from './strip-metadata';

export type UploadError =
  'EMPTY' | 'TOO_LARGE' | 'TYPE_NOT_ALLOWED' | 'TYPE_MISMATCH' | 'CORRUPT' | 'ACTIVE_CONTENT';

export interface CheckedUpload {
  type: AllowedType;
  /** What gets stored: the image without its metadata, or the PDF as received. */
  bytes: Uint8Array;
}

/** Names that make a PDF do something when opened. Escaped names (`/J#61vaScript`) are decoded before the look. */
const ACTIVE_PDF = [
  '/JavaScript',
  '/JS',
  '/Launch',
  '/OpenAction',
  '/EmbeddedFile',
  '/RichMedia',
  '/XFA',
  '/Encrypt',
];

export function pdfActiveContent(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes)
    .toString('latin1')
    .replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return ACTIVE_PDF.some((name) => {
    const re = new RegExp(`${name.replace('/', '\\/')}(?![A-Za-z0-9])`);
    return re.test(text);
  });
}

/**
 * The checks every stored document passes (AC-INT-03): not empty, within the size limit, the declared type allowed and equal
 * to what the first bytes show, an image that parses and loses its metadata, a PDF with no active content and a closing
 * marker. Pure: no I/O.
 */
export function validateUpload(input: {
  declaredType: string;
  bytes: Uint8Array;
  maxBytes: number;
}): Result<CheckedUpload, UploadError> {
  const { declaredType, bytes, maxBytes } = input;
  if (bytes.length === 0) return err('EMPTY');
  if (bytes.length > maxBytes) return err('TOO_LARGE');
  const declared = declaredType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isAllowedType(declared)) return err('TYPE_NOT_ALLOWED');
  const sniffed = sniffFileType(bytes);
  if (sniffed === null) return err('TYPE_NOT_ALLOWED');
  if (sniffed !== declared) return err('TYPE_MISMATCH');
  if (sniffed === 'application/pdf') {
    const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1');
    if (!tail.includes('%%EOF')) return err('CORRUPT');
    if (pdfActiveContent(bytes)) return err('ACTIVE_CONTENT');
    return ok({ type: sniffed, bytes });
  }
  try {
    return ok({ type: sniffed, bytes: stripImageMetadata(sniffed, bytes) });
  } catch (error) {
    if (error instanceof CorruptFileError) return err('CORRUPT');
    throw error;
  }
}
