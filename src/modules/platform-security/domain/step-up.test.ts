import { describe, expect, it } from 'vitest';
import { isSensitiveAction, needsStepUp, sensitiveActionBlocker, STEP_UP_MAX_AGE_MS } from './step-up';

const now = new Date('2026-11-23T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('needsStepUp (SPEC §5, AC-SEC-09)', () => {
  it('is not needed when the last second factor is at most 10 minutes old', () => {
    expect(needsStepUp(ago(STEP_UP_MAX_AGE_MS), now)).toBe(false);
    expect(needsStepUp(ago(60_000), now)).toBe(false);
  });

  it('is needed when it is older than 10 minutes', () => {
    expect(needsStepUp(ago(STEP_UP_MAX_AGE_MS + 1), now)).toBe(true);
  });

  it('is needed when the session never passed a second factor', () => {
    expect(needsStepUp(null, now)).toBe(true);
  });

  it('is needed for a timestamp in the future (clock skew or tampering)', () => {
    expect(needsStepUp(new Date(now.getTime() + 60_000), now)).toBe(true);
  });
});

describe('sensitiveActionBlocker', () => {
  it('requires re-enrolment first after a recovery-code login, even with a fresh second factor', () => {
    expect(sensitiveActionBlocker({ reenrolRequired: true, twoFactorAt: now }, now)).toBe('REENROL_REQUIRED');
  });

  it('otherwise requires a fresh second factor', () => {
    expect(
      sensitiveActionBlocker({ reenrolRequired: false, twoFactorAt: ago(STEP_UP_MAX_AGE_MS + 1) }, now),
    ).toBe('STEP_UP_REQUIRED');
    expect(sensitiveActionBlocker({ reenrolRequired: false, twoFactorAt: ago(1000) }, now)).toBeNull();
  });
});

describe('sensitive action registry', () => {
  it('covers the actions listed in SPEC-platform-security §5', () => {
    for (const action of [
      'ai.confirm_command',
      'alert.reclassify',
      'ledger.reverse_entry',
      'ledger.credit_note',
      'parameters.change',
      'clock.advance',
      'users.manage',
      'auth.regenerate_recovery_codes',
    ]) {
      expect(isSensitiveAction(action), action).toBe(true);
    }
  });

  it('does not include ordinary actions', () => {
    expect(isSensitiveAction('orders.create')).toBe(false);
  });
});
