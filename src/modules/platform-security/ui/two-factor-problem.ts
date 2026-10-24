/** What the second-factor screen tells the person after a refused or failed verification. */
export type TwoFactorProblem = 'invalid' | 'expired' | 'locked' | 'error';

/**
 * Tells apart a wrong code, an expired challenge (cookie gone, session lost, or too many wrong tries on this
 * challenge), a rate limit and a server or network failure. Anything else a 4xx means is a refused code.
 * `status` is undefined when the request itself failed (network down).
 */
export function classifyTwoFactorFailure(
  status: number | undefined,
  code: string | undefined,
): TwoFactorProblem {
  if (status === undefined || status >= 500) return 'error';
  if (status === 429) return 'locked';
  if (code === 'INVALID_TWO_FACTOR_COOKIE' || code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') return 'expired';
  return 'invalid';
}
