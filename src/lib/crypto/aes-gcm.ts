import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** AES-256-GCM with a random 96-bit IV. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function encryptString(base64Key: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(base64Key, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** Reverses encryptString; throws if the key is wrong or the data was altered. */
export function decryptString(base64Key: string, sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined)
    throw new Error('Unrecognized ciphertext format');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(base64Key, 'base64'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
