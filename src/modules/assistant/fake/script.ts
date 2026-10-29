import type { LlmRequest, LlmResponse } from '@/lib/ai/llm-provider';
import { composeAnswer, type Lang, NO_TOOL, readToolMessages } from './answer';
import { routeQuestion, type RouteEnv } from './route';

const REMINDER = /^Your answer (?:contained|must be)/;

const usage = { inputTokens: 0, outputTokens: 0 };

/**
 * The script of the Fake provider: it reads the masked question, picks a tool among those offered (the recorded phrasings of the
 * AC-ASSIST-18 set, in French and Darija), then writes its answer from the tool results with their placeholders, so the answer goes
 * through the very same post-checks as a real model's. It makes no network call and knows no data of its own.
 */
export function fakeScript(env: () => RouteEnv): (request: LlmRequest) => LlmResponse {
  return (request) => {
    const lang: Lang = request.system.includes('Answer in Arabic') ? 'ar' : 'fr';
    const tools = readToolMessages(request.messages);
    if (tools.length > 0) return { text: composeAnswer(tools, lang), toolCalls: [], usage, model: 'fake' };
    const question =
      [...request.messages].reverse().find((m) => m.role === 'user' && !REMINDER.test(m.content))?.content ??
      '';
    const routed = routeQuestion(
      question,
      request.tools.map((t) => t.name),
      env(),
    );
    if (!routed) return { text: NO_TOOL[lang], toolCalls: [], usage, model: 'fake' };
    return {
      text: null,
      toolCalls: [{ id: 'fake-1', name: routed.name, args: routed.args }],
      usage,
      model: 'fake',
    };
  };
}
