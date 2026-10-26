import {
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  ProviderError,
} from './llm-provider';

/** What the adapter needs to know before it may exist. The four conditions of SPEC-assistant §3 are checked from these. */
export interface RealProviderConfig {
  assistantEnabled: boolean;
  realData: boolean;
  nodeEnv: 'development' | 'test' | 'production';
  provider: 'fake' | 'anthropic';
  apiKey: string | undefined;
  model: string;
}

export type RealProviderBlocker =
  'ASSISTANT_DISABLED' | 'REAL_DATA' | 'PRODUCTION_BUILD' | 'PROVIDER_NOT_ANTHROPIC' | 'NO_KEY';

/** The first reason the real provider must not run, or null when all conditions hold. Names the condition, never a value. */
export function realProviderBlocker(c: Omit<RealProviderConfig, 'model'>): RealProviderBlocker | null {
  if (!c.assistantEnabled) return 'ASSISTANT_DISABLED';
  if (c.realData) return 'REAL_DATA';
  if (c.nodeEnv === 'production') return 'PRODUCTION_BUILD';
  if (c.provider !== 'anthropic') return 'PROVIDER_NOT_ANTHROPIC';
  if (!c.apiKey) return 'NO_KEY';
  return null;
}

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 20_000;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function toApiMessages(messages: LlmMessage[]): { role: 'user' | 'assistant'; content: string | Block[] }[] {
  const out: { role: 'user' | 'assistant'; content: string | Block[] }[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? [])
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content: blocks });
    } else {
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      // Results of one assistant turn go in one user message.
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

/**
 * The adapter to the real model. It is built, and so can run, only when ALL of these hold: ASSISTANT_ENABLED=true, REAL_DATA=false,
 * not a production build, ASSISTANT_PROVIDER=anthropic (and a key is present). Otherwise it throws before touching anything.
 * No SDK: one `fetch` to the Messages API, so the key is read in this file only and no dependency is added. Errors carry a
 * kind and a status, never the key, the payload or the response body (the body may repeat the payload).
 */
export function createAnthropicProvider(
  config: RealProviderConfig,
  deps: { fetch?: typeof fetch } = {},
): LlmProvider {
  const blocker = realProviderBlocker(config);
  if (blocker) throw new ProviderError('refused', `The real provider is refused: ${blocker}`);
  const apiKey = config.apiKey as string;
  const doFetch = deps.fetch ?? fetch;
  return {
    id: 'anthropic',
    async generate(request: LlmRequest): Promise<LlmResponse> {
      // The conditions are checked again at each call: a build that was refused once stays refused.
      const again = realProviderBlocker(config);
      if (again) throw new ProviderError('refused', `The real provider is refused: ${again}`);
      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxOutputTokens ?? 1024,
            system: request.system,
            messages: toApiMessages(request.messages),
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const timeout = (error as { name?: string }).name === 'TimeoutError';
        throw new ProviderError(
          timeout ? 'timeout' : 'http',
          timeout ? 'The provider timed out' : 'The provider is unreachable',
        );
      }
      if (!response.ok) throw new ProviderError('http', `The provider answered ${response.status}`);
      const body = (await response.json().catch(() => null)) as {
        content?: Block[];
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      } | null;
      if (!body || !Array.isArray(body.content))
        throw new ProviderError('invalid_response', 'The provider answer is not usable');
      const text = body.content
        .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = body.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input }));
      return {
        text: toolCalls.length > 0 ? null : text,
        toolCalls,
        usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
        model: body.model ?? config.model,
      };
    },
  };
}
