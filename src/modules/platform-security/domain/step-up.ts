/** Default maximum age of the second factor for a sensitive action (SPEC §5); parameter `auth.step_up_minutes`. */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

/** Actions that need a fresh second factor. Later modules use these ids with requireStepUp(). */
export const SENSITIVE_ACTIONS = [
  'ai.confirm_command',
  'alert.reclassify',
  'cash.apply_option',
  'load.confirm_excess',
  'load.cancel',
  'stock.adjust',
  'ledger.reverse_entry',
  'ledger.credit_note',
  'purchases.approve_invoice',
  'parameters.change',
  'clock.advance',
  'users.manage',
  'prices.confirm',
  'disclosure.decide',
  'documents.decide',
  'orders.release_hold',
  'credit_limit.set',
  'auth.regenerate_recovery_codes',
  'checklist.mark',
] as const;

export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export function isSensitiveAction(action: string): action is SensitiveAction {
  return (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}

export type SensitiveBlocker = 'REENROL_REQUIRED' | 'STEP_UP_REQUIRED';

/**
 * What stops a sensitive action now, if anything. A user who logged in with a recovery code must first enrol a new
 * authenticator (DECISIONS 72); otherwise the second factor must be a TOTP at most 10 minutes old.
 */
export function sensitiveActionBlocker(
  state: { reenrolRequired: boolean; twoFactorAt: Date | null },
  now: Date,
  maxAgeMs: number = STEP_UP_MAX_AGE_MS,
): SensitiveBlocker | null {
  if (state.reenrolRequired) return 'REENROL_REQUIRED';
  return needsStepUp(state.twoFactorAt, now, maxAgeMs) ? 'STEP_UP_REQUIRED' : null;
}

/** True unless the session's last second factor is between 0 and 10 minutes old. */
export function needsStepUp(
  twoFactorAt: Date | null,
  now: Date,
  maxAgeMs: number = STEP_UP_MAX_AGE_MS,
): boolean {
  if (!twoFactorAt) return true;
  const age = now.getTime() - twoFactorAt.getTime();
  return age < 0 || age > maxAgeMs;
}
