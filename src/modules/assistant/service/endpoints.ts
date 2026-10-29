import type pg from 'pg';
import { z } from 'zod';
import type { LlmProvider } from '@/lib/ai/llm-provider';
import type { StepUpResult } from '@/modules/platform-security';
import type { SessionUser } from '@/modules/platform-security';
import type { EngineParams } from '@/modules/rules-engine';
import { needsStepUp, type ProposalCard } from '../domain/drafts';
import type { LeakIndex } from '../domain/leak-scan';
import type { PayloadCipher } from './cipher';
import {
  confirmProposal,
  listProposals,
  proposalAction,
  rejectProposal,
  type ConfirmResult,
} from './proposals';
import { runTurn, type TurnResult } from './turn';

/**
 * Everything an endpoint needs, given by the route that received the request (pools, clock, engine, keys), so that the logic of the
 * endpoints can be tested without a server. `enabled` is the flag: with it off, every endpoint answers 404 before it reads the
 * body, touches a pool or asks for a provider, and `provider` is never called.
 */
export interface EndpointContext {
  enabled: boolean;
  user: SessionUser;
  appPool: pg.Pool;
  authPool: pg.Pool;
  systemPool: pg.Pool;
  cipher: PayloadCipher;
  hmacKey: string;
  today: string;
  engine: EngineParams;
  model: string;
  provider: () => LlmProvider | null;
  leakIndex: () => Promise<LeakIndex>;
  /** Runs `fn` as the current user only if the second factor is fresh; the route wires the real guard. */
  stepUp: <T>(fn: (user: SessionUser) => Promise<T>) => Promise<StepUpResult<T>>;
}

export interface EndpointResponse {
  status: number;
  body: unknown;
}

const NOT_FOUND: EndpointResponse = { status: 404, body: { error: 'NOT_FOUND' } };

const askBody = z
  .object({
    question: z.string().trim().min(1).max(600),
    history: z
      .array(z.object({ question: z.string().max(1500), answer: z.string().max(1500) }).strict())
      .max(10)
      .optional(),
  })
  .strict();

/** The turn as the screen needs it: the answer, the chips, the results, what was sent, the drafts. */
export async function ask(ctx: EndpointContext, rawBody: unknown): Promise<EndpointResponse> {
  if (!ctx.enabled) return NOT_FOUND;
  const body = askBody.safeParse(rawBody);
  if (!body.success) return { status: 400, body: { error: 'INVALID' } };
  let provider: LlmProvider | null;
  try {
    provider = ctx.provider();
  } catch {
    // The real provider refused to be built: no fallback to anything else, and no detail.
    return { status: 503, body: { error: 'UNAVAILABLE' } };
  }
  if (!provider) return NOT_FOUND;
  const result: TurnResult = await runTurn(
    {
      appPool: ctx.appPool,
      authPool: ctx.authPool,
      systemPool: ctx.systemPool,
      provider,
      model: ctx.model,
      cipher: ctx.cipher,
      hmacKey: ctx.hmacKey,
      today: ctx.today,
      engine: ctx.engine,
      leakIndex: ctx.leakIndex,
    },
    ctx.user,
    body.data,
  );
  return { status: 200, body: result };
}

const deps = (ctx: EndpointContext) => ({ appPool: ctx.appPool, cipher: ctx.cipher, today: ctx.today });

export async function proposals(ctx: EndpointContext): Promise<EndpointResponse> {
  if (!ctx.enabled) return NOT_FOUND;
  const cards: ProposalCard[] = await listProposals(deps(ctx), ctx.user);
  return { status: 200, body: { proposals: cards } };
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  EXPIRED: 410,
  STEP_UP_REQUIRED: 403,
  STALE: 409,
  FAILED: 422,
};

const respond = (r: ConfirmResult): EndpointResponse =>
  r.ok
    ? { status: 200, body: { proposal: r.card } }
    : { status: STATUS[r.error] ?? 400, body: { error: r.error } };

/**
 * Confirms a draft. A draft that writes a money record goes through the second-factor guard first: without a fresh factor the answer
 * is `STEP_UP_REQUIRED` and nothing is claimed, so the screen asks for the code and sends the same request again.
 */
export async function confirm(ctx: EndpointContext, id: string): Promise<EndpointResponse> {
  if (!ctx.enabled) return NOT_FOUND;
  const action = await proposalAction(deps(ctx), ctx.user, id);
  if (!action) return NOT_FOUND;
  if (!needsStepUp(action as Parameters<typeof needsStepUp>[0]))
    return respond(await confirmProposal(deps(ctx), ctx.user, id, { stepUpOk: false }));
  const guarded = await ctx.stepUp((user) => confirmProposal(deps(ctx), user, id, { stepUpOk: true }));
  if (!guarded.ok) return { status: 403, body: { error: guarded.error } };
  return respond(guarded.value);
}

export async function reject(ctx: EndpointContext, id: string): Promise<EndpointResponse> {
  if (!ctx.enabled) return NOT_FOUND;
  return respond(await rejectProposal(deps(ctx), ctx.user, id));
}
