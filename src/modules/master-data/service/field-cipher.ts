import { type Keyring, parseKeyring } from '@/lib/crypto/keyring';
import { getEnv } from '@/lib/server-env';

/** Seals the personal fields of master data (phones, addresses) with FIELD_ENCRYPTION_KEYS. null stays null. */
export interface FieldCipher {
  seal(plain: string | null): string | null;
  open(sealed: string | null): string | null;
}

export function fieldCipherFrom(keyring: Keyring): FieldCipher {
  return {
    seal: (plain) => (plain === null ? null : keyring.encrypt(plain)),
    open: (sealed) => (sealed === null ? null : keyring.decrypt(sealed)),
  };
}

let cached: FieldCipher | undefined;

/** The cipher of the running app; services take it as an optional argument so tests can supply their own. */
export function defaultFieldCipher(): FieldCipher {
  cached ??= fieldCipherFrom(parseKeyring(getEnv().FIELD_ENCRYPTION_KEYS));
  return cached;
}
