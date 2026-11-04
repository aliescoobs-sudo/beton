// The training instance (T1): the rules that keep fictitious data and production apart. A leaf with no import.

/** The only email domain of training accounts: a password alone opens them, and only while TRAINING_MODE is on. */
export const TRAINING_EMAIL_DOMAIN = 'formation.beton.invalid';

export const isTrainingEmail = (email: string): boolean =>
  email.toLowerCase().endsWith(`@${TRAINING_EMAIL_DOMAIN}`);

/**
 * The startup rule: the flag and the database must agree. A database that holds the training seed refuses to run without
 * TRAINING_MODE (it would be a production-looking server serving fictitious data and password-only accounts), and TRAINING_MODE
 * next to APP_ENV=production is refused (the environment schema refuses it too; this is the same rule checked once more at boot).
 * Returns the reason to stop, or null.
 */
export function trainingBootProblem(input: {
  trainingMode: boolean;
  appEnv: string | undefined;
  databaseSeeded: boolean;
}): string | null {
  if (input.trainingMode && input.appEnv === 'production')
    return 'TRAINING_MODE=true is refused when APP_ENV=production: the training instance never runs as production.';
  if (input.databaseSeeded && !input.trainingMode)
    return 'This database holds the training seed (fictitious data and password-only accounts) but TRAINING_MODE is not "true": refusing to start. Use the training instance for it, or a clean database.';
  return null;
}
