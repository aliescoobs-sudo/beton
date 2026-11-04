/**
 * Every column sealed with a keyring (f1.<keyId>.…) or, for TOTP seeds, with Better Auth's versioned secrets ($ba$<version>$…). `pnpm crypto:rotate` re-encrypts them to the current key;
 * a column missing here would keep an old key in use forever. Later modules register their columns here.
 */
export const ENCRYPTED_COLUMNS = [
  { table: 'twoFactor', column: 'backupCodes', idColumn: 'id', keyring: 'RECOVERY_CODES_KEYS', pool: 'auth' },
  // TOTP seeds: sealed by Better Auth with the versioned AUTH_SECRETS (not a keyring).
  { table: 'twoFactor', column: 'secret', idColumn: 'id', keyring: 'AUTH_SECRETS', pool: 'auth' },
  {
    table: 'two_factor_pending',
    column: 'secret',
    idColumn: 'user_id',
    keyring: 'AUTH_SECRETS',
    pool: 'auth',
  },
  {
    table: 'two_factor_pending',
    column: 'backup_codes',
    idColumn: 'user_id',
    keyring: 'RECOVERY_CODES_KEYS',
    pool: 'auth',
  },
  // Personal data of master data. These tables are under FORCE RLS: crypto:rotate reads and re-seals them as the
  // system actor (pool 'system'), which may update only these columns.
  { table: 'client', column: 'phone_enc', idColumn: 'id', keyring: 'FIELD_ENCRYPTION_KEYS', pool: 'system' },
  {
    table: 'client_site',
    column: 'address_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  {
    table: 'supplier',
    column: 'phone_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  // The phone app's addresses (R4, R6): an instruction's address, a pump job's site address, the address a redirect sends a load to.
  {
    table: 'trip_instruction',
    column: 'address_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  {
    table: 'pump_job',
    column: 'address_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  {
    table: 'cancellation_case',
    column: 'redirect_address_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  // The assistant's sealed payloads (SPEC-assistant §9): the question and the answer, the parameters of a draft.
  {
    table: 'ai_interaction',
    column: 'question_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  {
    table: 'ai_interaction',
    column: 'output_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
  {
    table: 'ai_proposal',
    column: 'params_enc',
    idColumn: 'id',
    keyring: 'FIELD_ENCRYPTION_KEYS',
    pool: 'system',
  },
] as const;

export type EncryptedColumn = {
  table: string;
  column: string;
  idColumn: string;
  keyring: 'FIELD_ENCRYPTION_KEYS' | 'RECOVERY_CODES_KEYS' | 'AUTH_SECRETS';
  pool: 'auth' | 'app' | 'system';
};
