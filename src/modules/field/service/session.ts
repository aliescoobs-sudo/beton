import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

// The phone's session: a signed token in an httpOnly cookie. It names a driver and the phone (a hash of the device id); the
// database still checks, on every request, that the driver is active and that this phone is the bound one, so a revoked phone
// stops working at once. The key is derived from AUTH_SECRET (one secret to rotate), never the secret itself.

export const FIELD_COOKIE = 'bb_field';
export const FIELD_SESSION_DAYS = 14;

export interface FieldToken {
  driverId: string;
  deviceHash: string;
  /** The generation of the phone's session on the server (T10c): a logout or a newer login moves it and this token stops working. */
  gen: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const keyOf = (secret: string): Buffer =>
  Buffer.from(hkdfSync('sha256', secret, 'belgobeton', 'field-session-v1', 32));

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signFieldToken(secret: string, token: FieldToken): string {
  const body = b64(JSON.stringify(token));
  return `${body}.${b64(createHmac('sha256', keyOf(secret)).update(body).digest())}`;
}

export function verifyFieldToken(
  secret: string,
  raw: string | undefined,
  nowSeconds: number,
): FieldToken | null {
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', keyOf(secret)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<FieldToken>;
    if (
      typeof t.driverId !== 'string' ||
      typeof t.deviceHash !== 'string' ||
      typeof t.exp !== 'number' ||
      typeof t.gen !== 'number' ||
      !Number.isInteger(t.gen)
    )
      return null;
    return t.exp > nowSeconds ? (t as FieldToken) : null;
  } catch {
    return null;
  }
}

/** The device id the phone generated, hashed: the database never holds the raw id. */
export function hashDeviceId(secret: string, deviceId: string): string {
  return createHmac('sha256', keyOf(secret)).update(`device:${deviceId}`).digest('hex');
}
