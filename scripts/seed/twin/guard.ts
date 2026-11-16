// T20 (D251): what the twin seed refuses, kept pure so a unit test proves each refusal without a database.
// The seed writes only into a database that is EXPLICITLY marked fictitious: an environment flag (TWIN_SEED_FICTITIOUS=true, chosen by the
// person running it) AND the training marker row of the database (checked by the caller). It refuses on any production-looking environment.

/** The one fixed date the whole twin is built around: every other date is relative to it (D251). */
export const TWIN_ANCHOR = '2026-11-15';
/** The fixed seed of the pseudo-random generator: the same seed and anchor always give the same twin. */
export const TWIN_PRNG_SEED = 20_261_115;
/** First day of the sales history. */
export const TWIN_HISTORY_START = '2026-09-01';
/** The opening date of the books as the go-live will load it (D246). */
export const TWIN_OPENING_DATE = '2026-11-30';

export interface TwinEnv {
  TWIN_SEED_FICTITIOUS?: string | undefined;
  TRAINING_MODE?: boolean | undefined;
  APP_ENV?: string | undefined;
  REAL_DATA?: boolean | undefined;
  NODE_ENV?: string | undefined;
  APP_BASE_URL?: string | undefined;
  DATABASE_URL_MIGRATOR?: string | undefined;
}

/** A word that says "this is the real thing" in a host name or a database name. Token match, so `preprod` or `product-demo` do not fool it either way. */
const PRODUCTION_WORDS = /(^|[^a-z0-9])(prod|production|live|real|reel|vrai)([^a-z0-9]|$)/i;

export function productionLooking(env: TwinEnv): string | null {
  if (env.APP_ENV === 'production') return 'APP_ENV is "production"';
  if (env.REAL_DATA) return 'REAL_DATA is "true"';
  if (!env.TRAINING_MODE)
    return 'TRAINING_MODE is not "true" (only a training or staging instance may hold the twin)';
  for (const [label, value] of [
    ['the database name', databaseName(env.DATABASE_URL_MIGRATOR)],
    ['the application host', hostName(env.APP_BASE_URL)],
    ['the database host', hostName(env.DATABASE_URL_MIGRATOR)],
  ] as const) {
    if (value && PRODUCTION_WORDS.test(value)) return `${label} looks like production (${value})`;
  }
  return null;
}

export function databaseName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

function hostName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The refusals that need no database. Returns the first reason, or null when the environment may go on to the marker check. */
export function twinEnvProblem(env: TwinEnv): string | null {
  const production = productionLooking(env);
  if (production) return `twin seed refused: ${production}`;
  if (env.TWIN_SEED_FICTITIOUS !== 'true')
    return 'twin seed refused: TWIN_SEED_FICTITIOUS is not "true" (the person running the seed must say the database is fictitious)';
  return null;
}
