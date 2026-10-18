import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT = 'f1';
const KEY_ID = /^[a-z0-9_-]{1,16}$/;

export interface Keyring {
  /** Id of the key new values are sealed with (the first one listed). */
  readonly currentId: string;
  /** AES-256-GCM with a random 96-bit IV. Output: `f1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). */
  encrypt(plaintext: string): string;
  /** Decrypts with whichever listed key sealed the value; throws if that key is gone or the data was altered. */
  decrypt(sealed: string): string;
  keyIdOf(sealed: string): string;
  needsRotation(sealed: string): boolean;
}

/**
 * Parses `id:base64key,id:base64key,…` (current key first, then retired keys still needed to decrypt). Errors name
 * the problem, never the key material. Rotate with `pnpm crypto:rotate`, then remove the retired key.
 */
export function parseKeyring(spec: string): Keyring {
  const keys = new Map<string, Buffer>();
  for (const entry of spec.split(',').map((e) => e.trim())) {
    const separator = entry.indexOf(':');
    const id = separator > 0 ? entry.slice(0, separator) : '';
    if (!KEY_ID.test(id))
      throw new Error('Keyring entries must look like <id>:<base64 key> with a short lowercase id');
    if (keys.has(id)) throw new Error(`Keyring lists key id "${id}" twice`);
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (key.length !== 32) throw new Error(`Key "${id}" must be 32 bytes, base64-encoded`);
    keys.set(id, key);
  }
  const currentId = [...keys.keys()][0]!;

  const parse = (sealed: string) => {
    const [format, keyId, iv, tag, ciphertext] = sealed.split('.');
    if (format !== FORMAT || !keyId || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unrecognized ciphertext format');
    }
    return { keyId, iv, tag, ciphertext };
  };

  return {
    currentId,
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(currentId)!, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [
        FORMAT,
        currentId,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decrypt(sealed) {
      const { keyId, iv, tag, ciphertext } = parse(sealed);
      const key = keys.get(keyId);
      if (!key) throw new Error(`Value was sealed with key "${keyId}", which is not in the keyring`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
    keyIdOf: (sealed) => parse(sealed).keyId,
    needsRotation: (sealed) => parse(sealed).keyId !== currentId,
  };
}
