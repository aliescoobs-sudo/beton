import { createHmac } from 'node:crypto';

/** HMAC-SHA256 of `value` with a base64 key: a lookup/identity hash that cannot be recomputed without the key. */
export function keyedHash(base64Key: string, value: string): Buffer {
  return createHmac('sha256', Buffer.from(base64Key, 'base64')).update(value, 'utf8').digest();
}
