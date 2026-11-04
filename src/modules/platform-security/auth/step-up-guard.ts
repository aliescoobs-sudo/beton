import { getPool } from '@/lib/db/pools';
import { type Clock, realClock } from '@/modules/clock';
import type { ParameterValues } from '../domain/parameters';
import {
  type SensitiveAction,
  sensitiveActionBlocker,
  type SensitiveBlocker,
  STEP_UP_MAX_AGE_MS,
} from '../domain/step-up';
import { readParameters } from '../service/parameter-service';
import type { AuthState, SessionUser } from './session-gate';

export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED' as const;
export const REENROL_REQUIRED = 'REENROL_REQUIRED' as const;

export type StepUpResult<T> =
  { ok: true; value: T } | { ok: false; error: SensitiveBlocker | 'UNAUTHENTICATED' };

export interface StepUpDeps {
  getState: () => Promise<AuthState>;
  clock?: Clock;
  /**
   * Where the policy (`auth.step_up_minutes`) is read. Callers do not need to pass it: the guard always reads the central policy from
   * the database itself (F12), so no action can forget it. Only tests and special callers substitute their own reader.
   */
  parameters?: () => Promise<ParameterValues>;
}

/**
 * Guard for sensitive server actions: runs `fn` only for an authenticated session whose second factor is a TOTP at
 * most 10 minutes old, and whose user does not have to re-enrol after a recovery-code login. Otherwise nothing runs
 * and the client shows the step-up dialog (or the re-enrolment page), then retries once.
 */
export async function withStepUp<T>(
  _action: SensitiveAction,
  fn: (user: SessionUser) => Promise<T>,
  { getState, clock = realClock, parameters = () => readParameters(getPool('auth')) }: StepUpDeps,
): Promise<StepUpResult<T>> {
  const state = await getState();
  if (state.kind !== 'authenticated') return { ok: false, error: 'UNAUTHENTICATED' };
  // The central policy, always. If it cannot be read the answer is "step up", never the default of a weaker rule.
  let maxAgeMs: number;
  try {
    maxAgeMs = Math.min((await parameters())['auth.step_up_minutes'] * 60_000, STEP_UP_MAX_AGE_MS);
  } catch {
    return { ok: false, error: 'STEP_UP_REQUIRED' };
  }
  const blocker = sensitiveActionBlocker(
    { reenrolRequired: state.user.reenrolRequired, twoFactorAt: state.session.twoFactorAt },
    clock.now(),
    maxAgeMs,
  );
  if (blocker) return { ok: false, error: blocker };
  return { ok: true, value: await fn({ ...state.user, stepUpVerified: true }) };
}
