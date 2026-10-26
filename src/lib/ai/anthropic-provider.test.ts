import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider, realProviderBlocker, type RealProviderConfig } from './anthropic-provider';
import { FakeProvider } from './fake-provider';
import { ProviderError } from './llm-provider';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
const allowed: RealProviderConfig = {
  assistantEnabled: true,
  realData: false,
  nodeEnv: 'development',
  provider: 'anthropic',
  apiKey: KEY,
  model: 'claude-sonnet-5-5',
};
const request = {
  tier: 'analysis' as const,
  system: 's',
  messages: [{ role: 'user' as const, content: 'q' }],
  tools: [],
};

describe('the real provider is refused unless every condition holds (AC-ASSIST-26)', () => {
  it('runs when all four hold', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 3, output_tokens: 1 },
        model: 'm',
      }),
    );
    const provider = createAnthropicProvider(allowed, { fetch: fetchMock as unknown as typeof fetch });
    const answer = await provider.generate(request);
    expect(answer.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ASSISTANT_DISABLED', { assistantEnabled: false }],
    ['REAL_DATA', { realData: true }],
    ['PRODUCTION_BUILD', { nodeEnv: 'production' as const }],
    ['PROVIDER_NOT_ANTHROPIC', { provider: 'fake' as const }],
    ['NO_KEY', { apiKey: undefined }],
  ])('refuses on its own: %s, without any request', (blocker, change) => {
    const fetchMock = vi.fn();
    const config = { ...allowed, ...change };
    expect(realProviderBlocker(config)).toBe(blocker);
    expect(() => createAnthropicProvider(config, { fetch: fetchMock as unknown as typeof fetch })).toThrow(
      ProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays refused if the configuration changes after it was built', async () => {
    const config = { ...allowed };
    const fetchMock = vi.fn();
    const provider = createAnthropicProvider(config, { fetch: fetchMock as unknown as typeof fetch });
    config.realData = true;
    await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the key never shows (AC-ASSIST-27)', () => {
  it('is not in an error, whatever the failure', async () => {
    for (const failing of [
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED with ${KEY}`);
      }),
      vi.fn(async () => new Response(`bad key ${KEY}`, { status: 401 })),
      vi.fn(async () => new Response(`not json ${KEY}`, { status: 200 })),
    ]) {
      const provider = createAnthropicProvider(allowed, { fetch: failing as unknown as typeof fetch });
      const error = await provider.generate(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(String((error as Error).message)).not.toContain(KEY);
      expect(JSON.stringify(error)).not.toContain(KEY);
    }
  });

  it('is sent only in the header of the one request to the provider', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ content: [{ type: 'text', text: 'ok' }] });
    });
    await createAnthropicProvider(allowed, { fetch: fetchMock as unknown as typeof fetch }).generate(request);
    expect(seen?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(String(seen?.init.body)).not.toContain(KEY);
    expect((seen?.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });
});

describe('the Fake provider', () => {
  it('counts its calls, keeps what it was sent and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const fake = new FakeProvider(() => ({
      text: 'x',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'fake',
    }));
    await fake.generate(request);
    expect(fake.calls).toBe(1);
    expect(fake.requests[0]?.messages[0]).toEqual({ role: 'user', content: 'q' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
