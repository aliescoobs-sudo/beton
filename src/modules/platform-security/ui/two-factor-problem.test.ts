import { describe, expect, it } from 'vitest';
import ar from '../../../../messages/ar.json';
import fr from '../../../../messages/fr.json';
import { classifyTwoFactorFailure, type TwoFactorProblem } from './two-factor-problem';

describe('classifyTwoFactorFailure', () => {
  it.each([
    [401, 'INVALID_CODE', 'invalid'],
    [401, undefined, 'invalid'],
    [400, 'INVALID_BACKUP_CODE', 'invalid'],
    [401, 'INVALID_TWO_FACTOR_COOKIE', 'expired'],
    [400, 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', 'expired'],
    [429, undefined, 'locked'],
    [429, 'INVALID_CODE', 'locked'],
    [500, undefined, 'error'],
    [503, 'ANYTHING', 'error'],
    [undefined, undefined, 'error'],
  ] as const)('%s %s -> %s', (status, code, expected) => {
    expect(classifyTwoFactorFailure(status, code)).toBe(expected);
  });

  it('has a message in both locales for every problem', () => {
    const problems: TwoFactorProblem[] = ['invalid', 'expired', 'locked', 'error'];
    for (const catalogue of [fr, ar]) {
      for (const p of problems) {
        expect(catalogue.auth.twoFactor[p as keyof typeof catalogue.auth.twoFactor]).toBeTruthy();
      }
    }
  });
});
