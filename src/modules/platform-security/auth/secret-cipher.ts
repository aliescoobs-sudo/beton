import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { type Env, parseAuthSecrets } from '@/lib/env';
import type { ColumnCipher } from '../service/key-rotation';

/**
 * Better Auth's own sealing of TOTP secrets (`$ba$<version>$…`), as a cipher for `crypto:rotate`. Values written
 * before versioning are bare hex sealed with AUTH_SECRET; decrypting them through `legacySecret` and sealing again
 * moves them onto the current version.
 */
export function authSecretCipher(env: Pick<Env, 'AUTH_SECRET' | 'AUTH_SECRETS'>): ColumnCipher {
  const secrets = parseAuthSecrets(env);
  const key = {
    keys: new Map(secrets.map((s) => [s.version, s.value])),
    currentVersion: secrets[0]!.version,
    legacySecret: env.AUTH_SECRET,
  };
  return {
    currentId: String(key.currentVersion),
    currentPattern: `$ba$${key.currentVersion}$%`,
    encrypt: (plaintext) => symmetricEncrypt({ key, data: plaintext }),
    decrypt: (sealed) => symmetricDecrypt({ key, data: sealed }),
  };
}
