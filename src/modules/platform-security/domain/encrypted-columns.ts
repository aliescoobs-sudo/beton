/**
 * Every column sealed with a keyring (f1.<keyId>.…). `pnpm crypto:rotate` re-encrypts them to the current key;
 * a column missing here would keep an old key in use forever. Later modules register their columns here.
 */
export const ENCRYPTED_COLUMNS = [
  { table: 'twoFactor', column: 'backupCodes', idColumn: 'id', keyring: 'RECOVERY_CODES_KEYS', pool: 'auth' },
] as const;

export type EncryptedColumn = {
  table: string;
  column: string;
  idColumn: string;
  keyring: 'FIELD_ENCRYPTION_KEYS' | 'RECOVERY_CODES_KEYS';
  pool: 'auth' | 'app';
};
