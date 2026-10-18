import { type Clock, realClock } from '@/modules/clock';
import { type SensitiveAction, sensitiveActionBlocker, type SensitiveBlocker } from '../domain/step-up';
import type { AuthState, SessionUser } from './session-gate';

export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED' as const;
export const REENROL_REQUIRED = 'REENROL_REQUIRED' as const;

export type StepUpResult<T> =
  { ok: true; value: T } | { ok: false; error: SensitiveBlocker | 'UNAUTHENTICATED' };

export interface StepUpDeps {
  getState: () => Promise<AuthState>;
  clock?: Clock;
}

/**
 * Guard for sensitive server actions: runs `fn` only for an authenticated session whose second factor is a TOTP at
 * most 10 minutes old, and whose user does not have to re-enrol after a recovery-code login. Otherwise nothing runs
 * and the client shows the step-up dialog (or the re-enrolment page), then retries once.
 */
export async function withStepUp<T>(
  _action: SensitiveAction,
  fn: (user: SessionUser) => Promise<T>,
  { getState, clock = realClock }: StepUpDeps,
): Promise<StepUpResult<T>> {
  const state = await getState();
  if (state.kind !== 'authenticated') return { ok: false, error: 'UNAUTHENTICATED' };
  const blocker = sensitiveActionBlocker(
    { reenrolRequired: state.user.reenrolRequired, twoFactorAt: state.session.twoFactorAt },
    clock.now(),
  );
  if (blocker) return { ok: false, error: blocker };
  return { ok: true, value: await fn(state.user) };
}
