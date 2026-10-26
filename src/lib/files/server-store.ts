import { parseKeyring } from '@/lib/crypto/keyring';
import { getEnv } from '@/lib/server-env';
import { createDiskStore, type FileStore } from './store';

let cached: FileStore | undefined;

/** The store of the running app: FILE_STORE_DIR, sealed with FIELD_ENCRYPTION_KEYS. Services take it as an argument in tests. */
export function defaultFileStore(): FileStore {
  const env = getEnv();
  cached ??= createDiskStore(env.FILE_STORE_DIR, parseKeyring(env.FIELD_ENCRYPTION_KEYS));
  return cached;
}
