import { z } from 'zod';
import { parseKeyring } from './crypto/keyring';

const flag = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .default('false')
  .transform((value) => value === 'true');

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' });

const base64Key32 = z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
  error: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
});

const keyring = z.string().superRefine((value, ctx) => {
  try {
    parseKeyring(value);
  } catch (error) {
    // parseKeyring's messages never contain key material.
    ctx.addIssue({
      code: 'custom',
      message: `must be <id>:<base64 32-byte key>[,…]: ${(error as Error).message}`,
    });
  }
});

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_APP: postgresUrl,
  DATABASE_URL_MIGRATOR: postgresUrl,
  DATABASE_URL_AUTH: postgresUrl,
  DATABASE_URL_SYSTEM: postgresUrl,
  AUTH_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),
  // Keyrings: current key first, then retired keys still needed to decrypt (see `pnpm crypto:rotate`).
  FIELD_ENCRYPTION_KEYS: keyring,
  RECOVERY_CODES_KEYS: keyring,
  LOOKUP_HMAC_KEY: base64Key32,
  APP_BASE_URL: z.url({ protocol: /^https?$/, error: 'must be the http(s) origin the app is served from' }),
  BACKUP_AGE_RECIPIENT: z.string().startsWith('age1', { error: 'must be an age public key (age1…)' }),
  SIMULATION_ENABLED: flag,
  REAL_DATA: flag,
});

// AC-CLK-02: a simulated clock must never run in production or next to real data.
const envSchema = envObject.superRefine((env, ctx) => {
  if (env.SIMULATION_ENABLED && (env.NODE_ENV === 'production' || env.REAL_DATA)) {
    ctx.addIssue({
      code: 'custom',
      path: ['SIMULATION_ENABLED'],
      message: 'must be "false" when NODE_ENV=production or REAL_DATA=true',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Backup job only (pnpm backup): the read-only BYPASSRLS role. Deliberately NOT part of the app environment
 * (DECISIONS open question 8: never in the app runtime); the security checklist checks the app does not have it.
 */
export function loadBackupUrl(source: Record<string, string | undefined>): string {
  const parsed = postgresUrl.safeParse(source.DATABASE_URL_BACKUP);
  if (!parsed.success) throw new Error('Invalid environment configuration:\n  DATABASE_URL_BACKUP: missing');
  return parsed.data;
}

/** Names of variables whose values must never reach logs. */
export const SECRET_ENV_NAMES = [
  'DATABASE_URL_APP',
  'DATABASE_URL_MIGRATOR',
  'DATABASE_URL_AUTH',
  'DATABASE_URL_SYSTEM',
  'AUTH_SECRET',
  'FIELD_ENCRYPTION_KEYS',
  'RECOVERY_CODES_KEYS',
  'LOOKUP_HMAC_KEY',
] as const satisfies readonly (keyof Env)[];

/** Every secret value (and each database password on its own) to scrub from logs. */
export function secretValuesOf(env: Env): string[] {
  const values: string[] = SECRET_ENV_NAMES.map((name) => env[name]);
  for (const name of SECRET_ENV_NAMES) {
    if (name.endsWith('_KEYS')) {
      for (const entry of env[name].split(',')) values.push(entry.slice(entry.indexOf(':') + 1).trim());
    }
    if (name.startsWith('DATABASE_URL_')) {
      const password = decodeURIComponent(new URL(env[name]).password);
      if (password) values.push(password);
    }
  }
  return values;
}

/**
 * Validates the environment. Throws one error naming every invalid variable;
 * the message never contains a received value.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(root)');
    return issue.code === 'invalid_type' ? `${name}: missing` : `${name}: ${issue.message}`;
  });
  throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
}
