import { createAnthropicProvider } from '@/lib/ai/anthropic-provider';
import { FakeProvider } from '@/lib/ai/fake-provider';
import type { LlmProvider } from '@/lib/ai/llm-provider';
import type { Env } from '@/lib/env';
import { fakeScript } from '../fake/script';

/**
 * The provider of this process, or none. With the flag off there is none: nothing is built, so nothing can be called. `fake` (the
 * default) is the scripted provider and makes no request. `anthropic` is built by an adapter that refuses unless the flag is on,
 * the data is fake, the build is not production and the provider is asked for by name (SPEC-assistant §3); a refusal throws here
 * and the endpoint answers "unavailable", never a fallback to something else.
 */
export function providerFor(
  env: Pick<
    Env,
    | 'ASSISTANT_ENABLED'
    | 'ASSISTANT_PROVIDER'
    | 'ASSISTANT_MODEL'
    | 'ANTHROPIC_API_KEY'
    | 'REAL_DATA'
    | 'NODE_ENV'
  >,
  today: string,
): LlmProvider | null {
  if (!env.ASSISTANT_ENABLED) return null;
  if (env.ASSISTANT_PROVIDER === 'anthropic')
    return createAnthropicProvider({
      assistantEnabled: env.ASSISTANT_ENABLED,
      realData: env.REAL_DATA,
      nodeEnv: env.NODE_ENV,
      provider: env.ASSISTANT_PROVIDER,
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ASSISTANT_MODEL,
    });
  return new FakeProvider(fakeScript(() => ({ today })));
}
