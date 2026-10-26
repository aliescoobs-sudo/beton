import { type Keyring, parseKeyring } from '@/lib/crypto/keyring';
import { getEnv } from '@/lib/server-env';

/** Seals the payloads of the assistant (the pseudonymized question, the answer, the parameters of a draft) with FIELD_ENCRYPTION_KEYS. */
export interface PayloadCipher {
  seal(plain: string): string;
  open(sealed: string): string;
}

export const cipherFrom = (keyring: Keyring): PayloadCipher => ({
  seal: (plain) => keyring.encrypt(plain),
  open: (sealed) => keyring.decrypt(sealed),
});

let cached: PayloadCipher | undefined;

export function defaultCipher(): PayloadCipher {
  cached ??= cipherFrom(parseKeyring(getEnv().FIELD_ENCRYPTION_KEYS));
  return cached;
}
