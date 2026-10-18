import { z } from 'zod';

const flag = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .default('false')
  .transform((value) => value === 'true');

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' });

const base64Key32 = z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
  error: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_APP: postgresUrl,
  DATABASE_URL_MIGRATOR: postgresUrl,
  DATABASE_URL_AUTH: postgresUrl,
  DATABASE_URL_SYSTEM: postgresUrl,
  AUTH_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),
  FIELD_ENCRYPTION_KEY: base64Key32,
  BACKUP_AGE_RECIPIENT: z.string().startsWith('age1', { error: 'must be an age public key (age1…)' }),
  SIMULATION_ENABLED: flag,
  REAL_DATA: flag,
});

export type Env = z.infer<typeof envSchema>;

/** Names of variables whose values must never reach logs. */
export const SECRET_ENV_NAMES = [
  'DATABASE_URL_APP',
  'DATABASE_URL_MIGRATOR',
  'DATABASE_URL_AUTH',
  'DATABASE_URL_SYSTEM',
  'AUTH_SECRET',
  'FIELD_ENCRYPTION_KEY',
] as const satisfies readonly (keyof Env)[];

/** Every secret value (and each database password on its own) to scrub from logs. */
export function secretValuesOf(env: Env): string[] {
  const values: string[] = SECRET_ENV_NAMES.map((name) => env[name]);
  for (const name of SECRET_ENV_NAMES) {
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
