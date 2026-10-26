import type pg from 'pg';
import type { LlmMessage, LlmProvider, LlmRequest } from '@/lib/ai/llm-provider';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import type { EngineParams } from '@/modules/rules-engine';
import { costMicroUsd } from '../domain/cost';
import { prepareForModel, toDataBlock } from '../domain/data-block';
import { displayResult, isPlainText } from '../domain/display';
import { type LeakIndex, scanForLeaks } from '../domain/leak-scan';
import { allowedFrom, checkNumbers } from '../domain/numbers-check';
import { MAX_RESULT_CHARS_PER_TURN, MAX_TOOL_CALLS_PER_TURN, type Outcome } from '../domain/outcome';
import { Pseudonymizer } from '../domain/pseudonymizer';
import { PROPOSAL_TTL_HOURS, type ProposalCard } from '../domain/drafts';
import { buildSystemPrompt, NUMBERS_REMINDER, SCHEMA_REMINDER } from '../domain/system-prompt';
import type { ToolContext } from '../domain/tool-types';
import type { PayloadCipher } from './cipher';
import { visibleEntities } from './entities';
import { runDraft } from './draft-runner';
import type { Prepared } from './drafts/types';
import { newInteractionId, type ProposalRecord, recordTurn, type ToolCallRecord } from './interaction-store';
import { uuidv7 } from '@/lib/uuidv7';
import { type GateResult, passGate } from './limits';
import { findDraftTool } from './drafts/registry';
import { toolSpecsFor } from './tool-registry';
import { runTool, type ToolOutcome } from './tool-runner';

export interface TurnDeps {
  appPool: pg.Pool;
  authPool: pg.Pool;
  systemPool: pg.Pool;
  provider: LlmProvider;
  model: string;
  cipher: PayloadCipher;
  hmacKey: string;
  /** The business date (the request clock). */
  today: string;
  engine: EngineParams;
  /** Every name and number the leak scan looks for. A failure to build it stops the turn. */
  leakIndex: () => Promise<LeakIndex>;
  /** The gate before anything else (kill switches, rate limit, budget); `passGate` unless a test brings its own. */
  gate?: (actor: SessionUser) => Promise<GateResult>;
}

export interface TurnInput {
  question: string;
  /** The turns before, as the person saw them. Re-masked here and sent as text only: nothing in it is trusted. */
  history?: { question: string; answer: string }[];
}

export interface ToolChip {
  tool: string;
  outcome: ToolOutcome;
  rows: number;
}

/** What was sent to the model, as built: the system prompt and the messages of the last request (everything before is in it). */
export interface SentPayload {
  system: string;
  messages: LlmMessage[];
}

export type Refusal = 'disabled' | 'rate_limited' | 'budget_stop' | 'blocked_leak' | 'unavailable';

export interface TurnResult {
  interactionId: string;
  outcome: Outcome;
  /** Plain text with the real values put back, or null when the structured results are the answer (or there is none). */
  answer: string | null;
  /** The tool results are shown without prose. */
  fallback: boolean;
  /** Why nothing was answered, for a message in the person's language. */
  refusal: Refusal | null;
  /** What the leak scan found when it stopped the turn: kinds only (name, number, long_number…), never a value. */
  leakKinds: string[];
  chips: ToolChip[];
  /** The results the person may read, as they would see them on a screen, for the fallback and the detail. */
  results: { tool: string; data: unknown }[];
  sent: SentPayload | null;
  /** The drafts this turn made, as cards for the person to check and confirm. */
  proposals: ProposalCard[];
  budgetPercent: number;
}

const MAX_DRAFTS_PER_TURN = 3;
const MAX_ROUNDS = 10;
const MAX_HISTORY = 10;
const MAX_HISTORY_CHARS = 600;

const empty = (over: Partial<TurnResult>): TurnResult => ({
  interactionId: '',
  outcome: 'ok',
  answer: null,
  fallback: false,
  refusal: null,
  leakKinds: [],
  chips: [],
  results: [],
  sent: null,
  proposals: [],
  budgetPercent: 0,
  ...over,
});

const refusalOf: Record<string, Refusal> = {
  disabled: 'disabled',
  rate_limited: 'rate_limited',
  budget_stop: 'budget_stop',
};

/**
 * One question to the assistant (SPEC-assistant §3). In order: the gate (kill switches, rate limit, budget: a refusal makes no
 * provider call), the pre-pass over the question, then a loop of at most six tool calls in which every request is leak-scanned before
 * it leaves and every tool runs as the asking user; the final text must be plain, must quote only numbers the tools returned (one
 * retry, then the structured results are the answer) and has its real values put back by code. The turn, its tool calls and its
 * outcome are recorded in every case, refusals included. The provider's failure never throws: it ends in the fallback.
 */
export async function runTurn(deps: TurnDeps, actor: SessionUser, input: TurnInput): Promise<TurnResult> {
  const started = realClock.now().getTime();
  const interactionId = newInteractionId();
  const store = (r: TurnRecordInput) =>
    recordTurn(
      deps.appPool,
      actor,
      {
        id: interactionId,
        locale: actor.locale,
        provider: r.provider,
        model: deps.model,
        rawQuestion: input.question,
        maskedQuestion: r.maskedQuestion,
        output: r.output,
        outcome: r.outcome,
        toolCalls: r.toolCalls,
        proposals: r.proposals,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costMicroUsd: costMicroUsd(r.provider, r.tokensIn, r.tokensOut),
        latencyMs: realClock.now().getTime() - started,
      },
      { cipher: deps.cipher, hmacKey: deps.hmacKey },
    );

  const gate = await (deps.gate ?? ((a: SessionUser) => passGate(deps, a)))(actor);
  if (gate.refusal) {
    await store({
      provider: 'none',
      maskedQuestion: '',
      output: '',
      outcome: gate.refusal,
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
    });
    return empty({
      interactionId,
      outcome: gate.refusal,
      refusal: refusalOf[gate.refusal] ?? 'unavailable',
      budgetPercent: gate.budgetPercent,
    });
  }

  const ps = new Pseudonymizer(await visibleEntities({ appPool: deps.appPool, actor }));
  const masked = ps.maskQuestion(input.question);
  const history: LlmMessage[] = (input.history ?? []).slice(-MAX_HISTORY).flatMap((h) => [
    { role: 'user' as const, content: ps.maskQuestion(h.question).slice(0, MAX_HISTORY_CHARS) },
    { role: 'assistant' as const, content: ps.maskQuestion(h.answer).slice(0, MAX_HISTORY_CHARS) },
  ]);
  const messages: LlmMessage[] = [...history, { role: 'user', content: masked }];
  const system = buildSystemPrompt(actor.role, actor.locale);
  const tools = toolSpecsFor(actor.role);
  const ctx: ToolContext = {
    appPool: deps.appPool,
    actor,
    today: deps.today,
    engine: deps.engine,
    codeOfName: (name) => ps.codeOfName(name),
  };

  let index: LeakIndex;
  try {
    index = await deps.leakIndex();
  } catch {
    // Without the means to check what leaves, nothing leaves.
    await store({
      provider: 'none',
      maskedQuestion: masked,
      output: '',
      outcome: 'refused',
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
    });
    return empty({
      interactionId,
      outcome: 'refused',
      refusal: 'unavailable',
      budgetPercent: gate.budgetPercent,
    });
  }

  const toolRecords: ToolCallRecord[] = [];
  const chips: ToolChip[] = [];
  const runs: { tool: string; data: unknown }[] = [];
  const prepared: unknown[] = [];
  const drafts: { id: string; prepared: Prepared; expiresAt: Date }[] = [];
  let toolCalls = 0;
  let resultChars = 0;
  let retries = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let sent: SentPayload | null = null;
  let outcome: Outcome = 'fallback';
  let answer: string | null = null;
  let leakKinds: string[] = [];

  const draftRun = async (name: string, args: unknown) => {
    // A turn makes at most a few drafts; the rest are refused like any call beyond a limit.
    if (drafts.length >= MAX_DRAFTS_PER_TURN)
      return {
        outcome: 'invalid_args' as const,
        result: { error: 'Too many drafts in this turn.' },
        rowCount: 0,
      };
    const r = await runDraft({ ...ctx, ps, authPool: deps.authPool }, name, args);
    if (r.prepared)
      drafts.push({
        id: uuidv7(realClock.now()),
        prepared: r.prepared,
        expiresAt: new Date(realClock.now().getTime() + PROPOSAL_TTL_HOURS * 3_600_000),
      });
    return { outcome: r.outcome, result: r.result, rowCount: r.prepared ? 1 : 0, args: r.args };
  };

  const finish = async (): Promise<TurnResult> => {
    const fallback = answer === null;
    await store({
      provider: deps.provider.id,
      maskedQuestion: masked,
      output: answer ?? '',
      outcome,
      toolCalls: toolRecords,
      proposals: drafts.map((d) => ({
        id: d.id,
        action: d.prepared.stored.action,
        expiresAt: d.expiresAt,
        payload: { stored: d.prepared.stored, card: d.prepared.card },
      })),
      tokensIn,
      tokensOut,
    });
    return {
      interactionId,
      outcome,
      answer,
      fallback,
      refusal: outcome === 'blocked_leak' ? 'blocked_leak' : null,
      leakKinds,
      chips,
      results: fallback
        ? runs.map((r) => ({ tool: r.tool, data: displayResult(r.data, (t) => ps.showNames(t)) }))
        : [],
      sent,
      proposals: drafts.map((d) => ({
        ...d.prepared.card,
        id: d.id,
        status: 'pending' as const,
        expiresAt: d.expiresAt.toISOString(),
        resultRef: null,
      })),
      budgetPercent: gate.budgetPercent,
    };
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const request: LlmRequest = { tier: 'analysis', system, messages, tools };
    // Every outbound payload is scanned: the question, the history, the tool results as the model will read them.
    const hits = scanForLeaks(JSON.stringify({ system, messages }), index);
    if (hits.length > 0) {
      leakKinds = [...new Set(hits.map((h) => h.kind))];
      outcome = 'blocked_leak';
      return finish();
    }
    sent = { system, messages: structuredClone(messages) };
    let response;
    try {
      response = await deps.provider.generate(request);
    } catch {
      outcome = 'fallback';
      return finish();
    }
    tokensIn += response.usage.inputTokens;
    tokensOut += response.usage.outputTokens;

    if (response.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls });
      for (const call of response.toolCalls) {
        if (toolCalls >= MAX_TOOL_CALLS_PER_TURN) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: '<data tool="limit">{"error":"Too many tool calls in this turn."}</data>',
          });
          continue;
        }
        toolCalls += 1;
        const draft = findDraftTool(call.name);
        const run: { outcome: ToolOutcome; result: unknown; rowCount: number; args?: unknown } = draft
          ? await draftRun(call.name, call.args)
          : await runTool(ctx, call.name, call.args);
        const prep = prepareForModel(run.result, ps);
        let block = toDataBlock(call.name, prep).text;
        resultChars += block.length;
        if (resultChars > MAX_RESULT_CHARS_PER_TURN)
          block = `<data tool="limit">{"error":"Results too long, ask for less."}</data>`;
        else if (run.outcome === 'ok') {
          prepared.push(prep);
          runs.push({ tool: call.name, data: run.result });
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: block });
        chips.push({ tool: call.name, outcome: run.outcome, rows: run.rowCount });
        toolRecords.push({
          tool: call.name.replace(/[^a-z_]/g, '').slice(0, 40) || 'unknown',
          args: run.args ?? {},
          outcome: run.outcome,
          rowCount: run.rowCount,
        });
      }
      continue;
    }

    const text = (response.text ?? '').trim();
    const plain = isPlainText(text);
    const numbers = plain ? checkNumbers(text, allowedFrom(prepared, masked)) : { ok: false, rejected: 0 };
    const hydrated = plain && numbers.ok ? ps.hydrate(text) : null;
    if (plain && numbers.ok && hydrated?.ok) {
      answer = ps.showNames(hydrated.value);
      outcome = 'ok';
      return finish();
    }
    if (retries < 1) {
      retries += 1;
      messages.push(
        { role: 'assistant', content: plain ? text : '' },
        { role: 'user', content: plain ? NUMBERS_REMINDER : SCHEMA_REMINDER },
      );
      continue;
    }
    outcome = plain ? 'rejected_numbers' : 'rejected_schema';
    return finish();
  }
  outcome = 'fallback';
  return finish();
}

interface TurnRecordInput {
  provider: 'fake' | 'anthropic' | 'none';
  maskedQuestion: string;
  output: string;
  outcome: Outcome;
  toolCalls: ToolCallRecord[];
  proposals?: ProposalRecord[];
  tokensIn: number;
  tokensOut: number;
}
