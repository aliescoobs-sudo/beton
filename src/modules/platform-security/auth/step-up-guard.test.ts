import { describe, expect, it, vi } from 'vitest';
import { createTestClock } from '@/modules/clock';
import type { AuthState } from './session-gate';
import { withStepUp } from './step-up-guard';

const clock = createTestClock(new Date('2026-11-23T10:00:00Z'));
const user = {
  id: 'u1',
  name: 'Owner',
  email: 'o@x.test',
  role: 'owner' as const,
  locale: 'fr' as const,
  twoFactorEnabled: true,
  reenrolRequired: false,
};
const authenticated = (twoFactorAt: Date | null): AuthState => ({
  kind: 'authenticated',
  user,
  session: { id: 's1', createdAt: new Date('2026-11-23T09:00:00Z'), twoFactorAt },
});

describe('withStepUp (AC-SEC-09)', () => {
  it('does not run the action when the user must re-enrol after a recovery-code login', async () => {
    const fn = vi.fn(async () => 'done');
    const state = authenticated(new Date('2026-11-23T09:59:00Z'));
    if (state.kind === 'authenticated') state.user = { ...state.user, reenrolRequired: true };
    expect(await withStepUp('users.manage', fn, { getState: async () => state, clock })).toEqual({
      ok: false,
      error: 'REENROL_REQUIRED',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs the action once when the second factor is fresh', async () => {
    const fn = vi.fn(async () => 'done');
    const result = await withStepUp('users.manage', fn, {
      getState: async () => authenticated(new Date('2026-11-23T09:55:00Z')),
      clock,
    });
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not run the action when the second factor is older than 10 minutes', async () => {
    const fn = vi.fn(async () => 'done');
    const result = await withStepUp('users.manage', fn, {
      getState: async () => authenticated(new Date('2026-11-23T09:49:00Z')),
      clock,
    });
    expect(result).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not run the action without an authenticated session', async () => {
    const fn = vi.fn(async () => 'done');
    expect(
      await withStepUp('users.manage', fn, { getState: async () => ({ kind: 'anonymous' }), clock }),
    ).toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
