/** A sensitive action needs a second factor no older than this (SPEC-platform-security §5, 🟡 A8). */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

/** Actions that need a fresh second factor. Later modules use these ids with requireStepUp(). */
export const SENSITIVE_ACTIONS = [
  'ai.confirm_command',
  'alert.reclassify',
  'ledger.reverse_entry',
  'parameters.change',
  'clock.advance',
  'users.manage',
  'auth.regenerate_recovery_codes',
] as const;

export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export function isSensitiveAction(action: string): action is SensitiveAction {
  return (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}

/** True unless the session's last second factor is between 0 and 10 minutes old. */
export function needsStepUp(twoFactorAt: Date | null, now: Date): boolean {
  if (!twoFactorAt) return true;
  const age = now.getTime() - twoFactorAt.getTime();
  return age < 0 || age > STEP_UP_MAX_AGE_MS;
}
