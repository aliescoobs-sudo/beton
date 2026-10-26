/**
 * Cost of a model call in whole micro-dollars. The prices are provisional constants of the pilot (per token, in micro-dollars:
 * 3 per input token and 15 per output token, a Sonnet-class rate): the budget gate needs an order of magnitude, the real figures
 * come from the provider's invoice and the evaluation (OQ5). Integer arithmetic only; the Fake provider costs nothing.
 */
export const PRICE_MICRO_USD_PER_TOKEN = { input: 3, output: 15 } as const;

export function costMicroUsd(
  provider: 'fake' | 'anthropic' | 'none',
  tokensIn: number,
  tokensOut: number,
): number {
  if (provider !== 'anthropic') return 0;
  return tokensIn * PRICE_MICRO_USD_PER_TOKEN.input + tokensOut * PRICE_MICRO_USD_PER_TOKEN.output;
}

/** The budget as a share used, in whole percent (rounded down), for the owner's 80 % warning. */
export function budgetPercentUsed(spentMicroUsd: number, budgetUsd: number): number {
  if (budgetUsd <= 0) return 100;
  return Math.floor((spentMicroUsd * 100) / (budgetUsd * 1_000_000));
}
