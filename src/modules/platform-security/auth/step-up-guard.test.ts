import { describe, expect, it, vi } from 'vitest';
import { createTestClock } from '@/modules/clock';
import { defaultParameters } from '../domain/parameters';
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
/** The central policy as the database would answer: `minutes` is auth.step_up_minutes. */
const policy =
  (minutes = 10) =>
  async () => ({ ...defaultParameters(), 'auth.step_up_minutes': minutes });
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
    expect(
      await withStepUp('users.manage', fn, { getState: async () => state, clock, parameters: policy() }),
    ).toEqual({
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
      parameters: policy(),
    });
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not run the action when the second factor is older than 10 minutes', async () => {
    const fn = vi.fn(async () => 'done');
    const result = await withStepUp('users.manage', fn, {
      getState: async () => authenticated(new Date('2026-11-23T09:49:00Z')),
      clock,
      parameters: policy(),
    });
    expect(result).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not run the action without an authenticated session', async () => {
    const fn = vi.fn(async () => 'done');
    expect(
      await withStepUp('users.manage', fn, {
        getState: async () => ({ kind: 'anonymous' }),
        clock,
        parameters: policy(),
      }),
    ).toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withStepUp reads the central policy itself (F12)', () => {
  it('a stricter policy shortens the window: a five-minute-old factor is refused at one minute', async () => {
    const fn = vi.fn(async () => 'done');
    const state = authenticated(new Date('2026-11-23T09:55:00Z'));
    const result = await withStepUp('prices.confirm', fn, {
      getState: async () => state,
      clock,
      parameters: policy(1),
    });
    expect(result).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
    expect(fn).not.toHaveBeenCalled();
  });
  it('a policy longer than the ten minutes of the specification does not weaken it', async () => {
    const fn = vi.fn(async () => 'done');
    const result = await withStepUp('prices.confirm', fn, {
      getState: async () => authenticated(new Date('2026-11-23T09:40:00Z')),
      clock,
      parameters: policy(60),
    });
    expect(result).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
  });
  it('a policy that cannot be read refuses (never falls back to a weaker rule)', async () => {
    const fn = vi.fn(async () => 'done');
    const result = await withStepUp('prices.confirm', fn, {
      getState: async () => authenticated(new Date('2026-11-23T09:59:50Z')),
      clock,
      parameters: async () => {
        throw new Error('database down');
      },
    });
    expect(result).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
    expect(fn).not.toHaveBeenCalled();
  });
  it('hands the action a user marked as stepped up, and only on this path', async () => {
    let seen: { stepUpVerified?: boolean } | null = null;
    await withStepUp(
      'prices.confirm',
      async (u) => {
        seen = u;
      },
      { getState: async () => authenticated(new Date('2026-11-23T09:59:00Z')), clock, parameters: policy() },
    );
    expect(seen).toMatchObject({ stepUpVerified: true });
    expect((user as { stepUpVerified?: boolean }).stepUpVerified).toBeUndefined();
  });
  it('without a reader given, the guard asks the database for the policy (the callers do not pass it)', async () => {
    vi.resetModules();
    const read = vi.fn(async () => ({ ...defaultParameters(), 'auth.step_up_minutes': 1 }));
    vi.doMock('../service/parameter-service', () => ({ readParameters: read }));
    vi.doMock('@/lib/db/pools', () => ({ getPool: () => ({}) }));
    const { withStepUp: guard } = await import('./step-up-guard');
    const result = await guard('disclosure.decide', async () => 'done', {
      getState: async () => authenticated(new Date('2026-11-23T09:55:00Z')),
      clock,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: false, error: 'STEP_UP_REQUIRED' });
    vi.doUnmock('../service/parameter-service');
    vi.doUnmock('@/lib/db/pools');
  });
});
