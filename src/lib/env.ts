import { z } from 'zod';
import { parseKeyring } from './crypto/keyring';

export interface AuthSecret {
  version: number;
  value: string;
}

/** Secrets Better Auth seals with, current first. Messages never contain secret material. */
export function parseAuthSecrets(env: {
  AUTH_SECRET: string;
  AUTH_SECRETS?: string | undefined;
}): AuthSecret[] {
  if (!env.AUTH_SECRETS) return [{ version: 1, value: env.AUTH_SECRET }];
  const seen = new Set<number>();
  return env.AUTH_SECRETS.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    const version = Number(entry.slice(0, separator));
    const value = entry.slice(separator + 1).trim();
    if (separator < 1 || !Number.isInteger(version) || version < 0) {
      throw new Error('AUTH_SECRETS entries must look like <version>:<secret>, the version a whole number');
    }
    if (value.length < 32) throw new Error(`AUTH_SECRETS version ${version} must be at least 32 characters`);
    if (seen.has(version)) throw new Error(`AUTH_SECRETS lists version ${version} twice`);
    seen.add(version);
    return { version, value };
  });
}

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
  // Which deployment this is. Unset on a developer machine. `production` is the real-data server; `training` the hands-on instance.
  APP_ENV: z.enum(['development', 'test', 'training', 'production']).optional(),
  DATABASE_URL_APP: postgresUrl,
  DATABASE_URL_AUTH: postgresUrl,
  DATABASE_URL_SYSTEM: postgresUrl,
  AUTH_SECRET: z.string().min(32, { error: 'must be at least 32 characters' }),
  // Versioned secrets for Better Auth (current first): `<version>:<secret>[,…]`. They seal the TOTP secrets, which
  // `pnpm crypto:rotate` moves to the current version. Unset: version 1 is AUTH_SECRET. AUTH_SECRET stays as the
  // fallback for values written before versioning.
  AUTH_SECRETS: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined || value === '') return;
      try {
        parseAuthSecrets({ AUTH_SECRET: 'x'.repeat(32), AUTH_SECRETS: value });
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }),
  // Keyrings: current key first, then retired keys still needed to decrypt (see `pnpm crypto:rotate`).
  FIELD_ENCRYPTION_KEYS: keyring,
  RECOVERY_CODES_KEYS: keyring,
  LOOKUP_HMAC_KEY: base64Key32,
  // Where the encrypted content of stored documents (BL scans, supplier invoice photos) lives: outside any public path.
  FILE_STORE_DIR: z.string().min(1).default('file-store'),
  APP_BASE_URL: z.url({ protocol: /^https?$/, error: 'must be the http(s) origin the app is served from' }),
  BACKUP_AGE_RECIPIENT: z.string().startsWith('age1', { error: 'must be an age public key (age1…)' }),
  SIMULATION_ENABLED: flag,
  REAL_DATA: flag,
  // T1: the hands-on training instance (fictitious data only, see docs/checkpoints/CP-TRAINING.md). It lets the training accounts sign in
  // with a password alone, shows a permanent banner, and switches off imports and every outbound integration. It is refused with
  // APP_ENV=production and with REAL_DATA=true, and a database that holds the training seed refuses to boot without it.
  TRAINING_MODE: flag,
  // C2: protected first start of a real-data server. With REAL_DATA=true and an incomplete security checklist the server normally
  // refuses to start (a loop: the checklist is completed in the app). FIRST_BOOT=true starts it in a restricted mode instead: only
  // sign-in, enrolment, the checklist, accounts, plants and parameters are served, everything else answers 503, and it refuses to
  // start at all once real business records exist or once the checklist is complete (remove the flag then). Never needed otherwise.
  FIRST_BOOT: flag,
  // The AI reading of a supplier invoice photo. OFF, and refused next to real data or in production, until the CNDP has
  // authorized the transfer (DECISIONS 107); even on, only an interface exists: no provider is wired and nothing leaves the server.
  AI_EXTRACTION_ENABLED: flag,
  // The in-app assistant (SPEC-assistant). OFF by default; refused next to real data or in production until the CNDP has
  // authorized the transfer (D114). `ASSISTANT_PROVIDER` is `fake` unless the real adapter is asked for, which needs the flag on,
  // fake data, a development or test build and a key. The key lives in .env.local only and is never sent to the client.
  // Module flag of the driver and pump phone app (R4, D122): off, its pages and endpoints answer 404.
  FIELD_APP_ENABLED: flag,
  // R5: the bell, the notification centre and push. Off: no entry point renders and the endpoints answer 404 (the database still records).
  NOTIFICATIONS_ENABLED: flag,
  // Batch B module flags (CP-PROD-PLAN): off, the pages answer 404 and the entry points do not render.
  CANCELLATIONS_ENABLED: flag,
  DOCUMENTS_V1_ENABLED: flag,
  DARIJA_ENABLED: flag,
  ASSISTANT_DET_ENABLED: flag,
  TRANSFERS_ENABLED: flag,
  // C1: finance module (Codex). Off by default; with it off its pages, exports and both endpoints answer 404 and no menu entry renders.
  // Even when on, the database switch (finance.enabled(), owner/app_admin with a fresh TOTP) must also be on.
  FINANCE_ENABLED: flag,
  ASSISTANT_ENABLED: flag,
  ASSISTANT_PROVIDER: z
    .enum(['fake', 'anthropic'], { error: 'must be "fake" or "anthropic"' })
    .default('fake'),
  ASSISTANT_MODEL: z.string().min(1).max(100).default('claude-sonnet-5-5'),
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim())),
  // R5: web push (VAPID). Optional: without a key pair the in-app centre still works and nothing is pushed. The push carries no content.
  VAPID_PUBLIC_KEY: z.string().trim().min(80).max(100).optional(),
  VAPID_PRIVATE_KEY: z.string().trim().min(40).max(60).optional(),
  VAPID_SUBJECT: z.string().trim().max(200).optional(),
  // Test servers (e2e) that share a database being recreated must not run the pg-boss cron scheduler.
  JOB_SCHEDULER_DISABLED: flag,
  // Reverse proxies in front of the app that each append the address they received the request from to
  // X-Forwarded-For. 0 (default): the header is ignored, since anyone can set it.
  TRUSTED_PROXY_HOPS: z.coerce
    .number({ error: 'must be a whole number of proxies (0 = none)' })
    .int({ error: 'must be a whole number of proxies (0 = none)' })
    .min(0)
    .max(5)
    .default(0),
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
  if (env.AI_EXTRACTION_ENABLED && (env.NODE_ENV === 'production' || env.REAL_DATA)) {
    ctx.addIssue({
      code: 'custom',
      path: ['AI_EXTRACTION_ENABLED'],
      message: 'must be "false" until the CNDP has authorized sending invoices to an AI provider',
    });
  }
  if (env.ASSISTANT_ENABLED && (env.NODE_ENV === 'production' || env.REAL_DATA)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ASSISTANT_ENABLED'],
      message: 'must be "false" until the CNDP has authorized sending questions to an AI provider',
    });
  }
  if (env.ASSISTANT_PROVIDER === 'anthropic' && (env.NODE_ENV === 'production' || env.REAL_DATA)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ASSISTANT_PROVIDER'],
      message: 'must be "fake" when NODE_ENV=production or REAL_DATA=true',
    });
  }
  if (env.ANTHROPIC_API_KEY && (env.NODE_ENV === 'production' || env.REAL_DATA)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message: 'must not be set when NODE_ENV=production or REAL_DATA=true',
    });
  }
  if (env.TRAINING_MODE && env.APP_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['TRAINING_MODE'],
      message: 'must be "false" when APP_ENV=production (the training instance never runs as production)',
    });
  }
  if (env.TRAINING_MODE && env.REAL_DATA) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRAINING_MODE'],
      message: 'must be "false" when REAL_DATA=true (the training instance holds fictitious data only)',
    });
  }
  if (env.ASSISTANT_ENABLED && env.ASSISTANT_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message: 'is required for the anthropic provider',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Maintenance scripts only (migrate, bootstrap, audit verify, owner 2FA reset): the runtime environment above deliberately has no
 * migrator login, so a compromised app cannot alter the schema (C2, DECISIONS open question 11). The login is read from the raw
 * environment, like the backup URL.
 */
export type MaintenanceEnv = Env & { DATABASE_URL_MIGRATOR: string };
export function loadMaintenanceEnv(source: Record<string, string | undefined>): MaintenanceEnv {
  const env = loadEnv(source);
  const migrator = postgresUrl.safeParse(source.DATABASE_URL_MIGRATOR);
  if (!migrator.success)
    throw new Error('Invalid environment configuration:\n  DATABASE_URL_MIGRATOR: missing');
  return { ...env, DATABASE_URL_MIGRATOR: migrator.data };
}

/**
 * Backup job only (pnpm backup): the read-only BYPASSRLS role. Deliberately NOT part of the app environment
 * (DECISIONS open question 8: never in the app runtime); the security checklist checks the app does not have it.
 */
export function loadBackupUrl(source: Record<string, string | undefined>): string {
  const parsed = postgresUrl.safeParse(source.DATABASE_URL_BACKUP);
  if (!parsed.success) throw new Error('Invalid environment configuration:\n  DATABASE_URL_BACKUP: missing');
  return parsed.data;
}

/**
 * The pilot seed's database role exists only in simulation: SIMULATION_ENABLED=true, never with REAL_DATA=true and never
 * in production (same rule as the seed guard and the boot guard). Read from the raw environment, like the backup URL.
 */
export function seedRoleAllowed(source: Record<string, string | undefined>): boolean {
  return (
    source.SIMULATION_ENABLED === 'true' && source.REAL_DATA !== 'true' && source.NODE_ENV !== 'production'
  );
}

/**
 * Pilot seed only (pnpm db:seed, db:bootstrap): the login of belgobeton_seed. Deliberately NOT part of the app
 * environment, and refused outside simulation.
 */
export function loadSeedUrl(source: Record<string, string | undefined>): string {
  if (!seedRoleAllowed(source)) {
    throw new Error(
      'DATABASE_URL_SEED refused: needs SIMULATION_ENABLED=true, REAL_DATA not "true", not production',
    );
  }
  const parsed = postgresUrl.safeParse(source.DATABASE_URL_SEED);
  if (!parsed.success) throw new Error('Invalid environment configuration:\n  DATABASE_URL_SEED: missing');
  return parsed.data;
}

/** Names of variables whose values must never reach logs. */
export const SECRET_ENV_NAMES = [
  'DATABASE_URL_APP',
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
  if (env.AUTH_SECRETS) values.push(...parseAuthSecrets(env).map((secret) => secret.value));
  if (env.ANTHROPIC_API_KEY) values.push(env.ANTHROPIC_API_KEY);
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
