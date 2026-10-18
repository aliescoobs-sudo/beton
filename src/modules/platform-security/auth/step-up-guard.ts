import { type Clock, realClock } from '@/modules/clock';
import { needsStepUp, type SensitiveAction } from '../domain/step-up';
import type { AuthState, SessionUser } from './session-gate';

export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED' as const;

export type StepUpResult<T> =
  { ok: true; value: T } | { ok: false; error: typeof STEP_UP_REQUIRED | 'UNAUTHENTICATED' };

export interface StepUpDeps {
  getState: () => Promise<AuthState>;
  clock?: Clock;
}

/**
 * Guard for sensitive server actions: runs `fn` only for an authenticated session whose second factor is at most
 * 10 minutes old. Otherwise nothing runs and the client shows the step-up dialog, then retries once.
 */
export async function withStepUp<T>(
  _action: SensitiveAction,
  fn: (user: SessionUser) => Promise<T>,
  { getState, clock = realClock }: StepUpDeps,
): Promise<StepUpResult<T>> {
  const state = await getState();
  if (state.kind !== 'authenticated') return { ok: false, error: 'UNAUTHENTICATED' };
  if (needsStepUp(state.session.twoFactorAt, clock.now())) return { ok: false, error: STEP_UP_REQUIRED };
  return { ok: true, value: await fn(state.user) };
}
