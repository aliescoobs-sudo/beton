/** The provider interface of SPEC-ai-layer §2, with tool calling (SPEC-assistant §3). Nothing in it knows a business entity. */
export type LlmTier = 'light' | 'analysis';

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object). */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  tier: LlmTier;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxOutputTokens?: number;
}

export interface LlmResponse {
  /** The final text, or null when the model asks for tools. */
  text: string | null;
  toolCalls: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LlmProvider {
  readonly id: 'fake' | 'anthropic';
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/** Why a provider could not answer: never carries a payload, a key or a response body. */
export class ProviderError extends Error {
  readonly kind: 'refused' | 'timeout' | 'http' | 'invalid_response';

  // No parameter property: this file also loads under plain node (the CLI scripts), which only strips types.
  constructor(kind: 'refused' | 'timeout' | 'http' | 'invalid_response', message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}
