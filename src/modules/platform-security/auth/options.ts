import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { BetterAuthOptions } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import type pg from 'pg';
import { parseKeyring } from '@/lib/crypto/keyring';
import { type Env, parseAuthSecrets } from '@/lib/env';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { PASSWORD_MAX, PASSWORD_MIN } from './password-policy';

export const SESSION_IDLE_SECONDS = 30 * 60; // SPEC §5 (🟡 A8)
export const SESSION_COOKIE_NAME = '__Host-bb.session_token';

export interface AuthDeps {
  /** Pool on the belgobeton_auth role: the only role that can read credential tables. */
  authPool: pg.Pool;
  env: Pick<Env, 'AUTH_SECRET' | 'AUTH_SECRETS' | 'APP_BASE_URL' | 'RECOVERY_CODES_KEYS' | 'LOOKUP_HMAC_KEY'>;
}

/** Better Auth configuration shared by the app, the CLI and the tests (ADR 0001). Hooks are added in createAuth(). */
export function baseAuthOptions({ authPool, env }: AuthDeps) {
  const recoveryKeys = parseKeyring(env.RECOVERY_CODES_KEYS);
  return {
    database: authPool,
    // Versioned secrets seal the TOTP secrets (rotated by `pnpm crypto:rotate`); `secret` decrypts older bare values.
    secret: env.AUTH_SECRET,
    secrets: parseAuthSecrets(env),
    baseURL: env.APP_BASE_URL,
    trustedOrigins: [env.APP_BASE_URL],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // accounts are created by the owner (or the bootstrap CLI) only
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      password: {
        hash: (password: string) => argon2Hash(password, { algorithm: 2 /* Argon2id */ }),
        verify: ({ hash, password }: { hash: string; password: string }) => argon2Verify(hash, password),
      },
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: true, input: false },
        locale: { type: 'string', required: true, defaultValue: 'fr', input: false },
        status: { type: 'string', required: true, defaultValue: 'active', input: false },
        // Set after a recovery-code login until a new authenticator is confirmed (DECISIONS 72).
        reenrolRequired: { type: 'boolean', required: true, defaultValue: false, input: false },
      },
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS, // sliding idle timeout; the 12 h absolute cap is in session-gate.ts
      updateAge: 60,
      cookieCache: { enabled: false }, // revocation must take effect immediately
      additionalFields: {
        twoFactorAt: { type: 'date', required: false, input: false }, // last TOTP success, for step-up
      },
    },
    advanced: {
      // Name the session cookie "__Host-…" ourselves (the automatic prefix would be "__Secure-").
      useSecureCookies: false,
      cookiePrefix: 'bb',
      cookies: { session_token: { name: SESSION_COOKIE_NAME } },
      defaultCookieAttributes: { sameSite: 'strict', httpOnly: true, secure: true, path: '/' },
      // Raw IPs are not stored; login_attempt keeps a keyed hash instead.
      ipAddress: { disableIpTracking: true },
      database: { generateId: () => uuidv7(realClock.now()) },
    },
    plugins: [
      twoFactor({
        issuer: 'KAYAS',
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
        backupCodeOptions: {
          amount: 10,
          // Dedicated, rotatable keyring from the environment, never stored in the database (ADR 0001, DECISIONS 69).
          storeBackupCodes: {
            encrypt: async (codes: string) => recoveryKeys.encrypt(codes),
            decrypt: async (sealed: string) => recoveryKeys.decrypt(sealed),
          },
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}
