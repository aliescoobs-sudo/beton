// Re-encrypts every registered encrypted column to the current key of its keyring.
//   corepack pnpm crypto:rotate            rotate
//   corepack pnpm crypto:rotate --check    only report rows still on retired keys (exit 1 if any)
// TOTP seeds rotate with AUTH_SECRETS (`<version>:<secret>,…`, new version first); keep AUTH_SECRET unchanged until
// every value has moved off bare (pre-versioning) values.
// Procedure: put the new key first in the keyring env var (keep the old one after it), restart, rotate,
// run --check, then remove the old key.
import { existsSync } from 'node:fs';
import pg from 'pg';
import { parseKeyring } from '@/lib/crypto/keyring';
import { loadEnv } from '@/lib/env';
import { ENCRYPTED_COLUMNS } from '@/modules/platform-security/domain/encrypted-columns';
import { authSecretCipher } from '@/modules/platform-security/auth/secret-cipher';
import {
  type ColumnCipher,
  countOnOldKeys,
  keyringCipher,
  rotateColumn,
} from '@/modules/platform-security/service/key-rotation';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const env = loadEnv(process.env);
const checkOnly = process.argv.includes('--check');
const pools = {
  auth: new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 }),
  app: new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 }),
};

let remaining = 0;
try {
  for (const spec of ENCRYPTED_COLUMNS) {
    const keyring: ColumnCipher =
      spec.keyring === 'AUTH_SECRETS'
        ? authSecretCipher(env)
        : keyringCipher(parseKeyring(env[spec.keyring]));
    if (checkOnly) {
      const n = await countOnOldKeys(pools[spec.pool], spec, keyring);
      remaining += n;
      console.log(
        `${spec.table}.${spec.column}: ${n} value(s) on retired keys (current: ${keyring.currentId})`,
      );
    } else {
      const result = await rotateColumn(pools[spec.pool], spec, keyring);
      remaining += result.remaining;
      console.log(
        `${spec.table}.${spec.column}: ${result.rotated} re-encrypted to ${keyring.currentId}, ${result.remaining} left`,
      );
    }
  }
} finally {
  await Promise.all(Object.values(pools).map((p) => p.end()));
}
if (remaining > 0) process.exitCode = 1;
else console.log('All encrypted values are on the current keys: retired keys can be removed.');
