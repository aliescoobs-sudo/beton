/** How a turn ended (SPEC-assistant §9). Each is an `ai_interaction.outcome` and is audited. */
export const OUTCOMES = [
  'ok',
  'rejected_schema',
  'rejected_numbers',
  'blocked_leak',
  'fallback',
  'refused',
  'rate_limited',
  'budget_stop',
  'disabled',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The outcomes where no provider was called at all: zero model calls beyond a limit (AC-ASSIST-15). */
export const NO_MODEL_OUTCOMES: readonly Outcome[] = ['rate_limited', 'budget_stop', 'disabled', 'refused'];

export const MAX_TOOL_CALLS_PER_TURN = 6;
/** Characters of tool results in a turn: about 4 000 tokens at three characters a token (the limit of SPEC-assistant §9). */
export const MAX_RESULT_CHARS_PER_TURN = 12_000;
