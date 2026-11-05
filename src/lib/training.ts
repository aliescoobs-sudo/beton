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
  /** TRAINING_ALLOW_UNMARKED: the e2e training server only. Refused by the environment schema outside tests of this kind. */
  allowUnmarked?: boolean;
}): string | null {
  if (input.trainingMode && input.appEnv === 'production')
    return 'TRAINING_MODE=true is refused when APP_ENV=production: the training instance never runs as production.';
  if (input.databaseSeeded && !input.trainingMode)
    return 'This database holds the training seed (fictitious data and password-only accounts) but TRAINING_MODE is not "true": refusing to start. Use the training instance for it, or a clean database.';
  // R11-02: the rule runs both ways. Training traffic is served only from a database a COMPLETED training seed has marked; the
  // flags and the banner never establish that the data are fictitious. An unmarked database (empty, half-seeded, or somebody's
  // real records) is refused: initialise a fresh one with seed:training.
  if (input.trainingMode && !input.databaseSeeded && !input.allowUnmarked)
    return 'TRAINING_MODE is "true" but this database carries no training marker (no completed training seed): refusing to serve it. Initialise a fresh database with the training seed (scripts/training-up.sh); never point training at an existing database.';
  return null;
}

/**
 * A warning (not a stop) at boot: the public address looks like a Tailscale Funnel / Serve name (*.ts.net) while TRAINING_MODE is off,
 * which would be a non-training server on the internet through the training machine's tunnel. The host script funnel-check.sh asks the
 * same question from outside the container.
 */
export function funnelWarning(input: { trainingMode: boolean; appBaseUrl: string }): string | null {
  if (input.trainingMode) return null;
  try {
    const host = new URL(input.appBaseUrl).hostname.toLowerCase();
    if (host === 'ts.net' || host.endsWith('.ts.net'))
      return `APP_BASE_URL is a Tailscale address (${host}) but TRAINING_MODE is not "true": check that this server is meant to be public (tailscale funnel status), or switch the Funnel off (tailscale funnel reset).`;
  } catch {
    // the environment check reports a malformed address
  }
  return null;
}

/** R11-08: the roles that can use the finance module. Finance asks for a REAL authenticator, which a training account may enrol if it wants. */
export const FINANCE_TRAINING_ROLES: readonly string[] = ['owner', 'app_admin', 'accountant'];

/** Whether a signed-in account is shown the optional authenticator enrolment (training accounts of a finance role without one). */
export const offersFinanceEnrolment = (user: {
  email: string;
  role: string;
  twoFactorEnabled: boolean;
}): boolean =>
  !user.twoFactorEnabled && isTrainingEmail(user.email) && FINANCE_TRAINING_ROLES.includes(user.role);
