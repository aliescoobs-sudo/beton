import type pg from 'pg';
import { keyedHash } from '@/lib/crypto/hmac';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { inRequest, recordAuditEvent, type SessionUser } from '@/modules/platform-security';
import type { Outcome } from '../domain/outcome';
import type { PayloadCipher } from './cipher';

export interface ToolCallRecord {
  tool: string;
  /** The validated arguments as the model gave them: codes, dates, quantities, placeholders. Never a name. */
  args: unknown;
  outcome: 'ok' | 'permission_denied' | 'invalid_args' | 'error' | 'blocked_leak';
  rowCount: number;
}

/** A draft made in this turn, to be stored with it: the sealed payload holds the resolved parameters and the card. */
export interface ProposalRecord {
  id: string;
  action: string;
  expiresAt: Date;
  payload: unknown;
}

export interface TurnRecord {
  id: string;
  locale: 'fr' | 'ar';
  provider: 'fake' | 'anthropic' | 'none';
  model: string;
  /** The raw question: only a keyed hash of it is stored. */
  rawQuestion: string;
  /** The question as the model saw it. */
  maskedQuestion: string;
  output: string;
  outcome: Outcome;
  toolCalls: ToolCallRecord[];
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  latencyMs: number;
  proposals?: ProposalRecord[];
}

export const newInteractionId = () => uuidv7(realClock.now());

/**
 * Writes the turn: the interaction, then its tool calls, in one transaction as the asking user (SPEC-assistant §9). The question
 * and the answer are sealed; the raw question is kept as a keyed hash only. The audit trail gets a row for each insert by the
 * capture trigger, so every question and every tool call is on the chain.
 */
export async function recordTurn(
  appPool: pg.Pool,
  actor: SessionUser,
  turn: TurnRecord,
  deps: { cipher: PayloadCipher; hmacKey: string },
): Promise<void> {
  const hash = keyedHash(deps.hmacKey, `ai-question:${turn.rawQuestion}`).toString('hex');
  await inRequest(appPool, actor, async (tx) => {
    await tx.query(
      `insert into ai_interaction (id, user_id, role, locale, provider, model, question_hash, question_enc, output_enc,
                                   outcome, tool_call_count, tokens_in, tokens_out, cost_micro_usd, latency_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        turn.id,
        actor.id,
        actor.role,
        turn.locale,
        turn.provider,
        turn.model,
        hash,
        deps.cipher.seal(turn.maskedQuestion),
        deps.cipher.seal(turn.output),
        turn.outcome,
        turn.toolCalls.length,
        turn.tokensIn,
        turn.tokensOut,
        turn.costMicroUsd,
        turn.latencyMs,
      ],
    );
    for (const p of turn.proposals ?? []) {
      await tx.query(
        `insert into ai_proposal (id, interaction_id, user_id, role, action, params_enc, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          p.id,
          turn.id,
          actor.id,
          actor.role,
          p.action,
          deps.cipher.seal(JSON.stringify(p.payload)),
          p.expiresAt.toISOString(),
        ],
      );
      await recordAuditEvent(tx, {
        action: 'ai_proposal',
        table: 'ai_proposal',
        rowId: p.id,
        after: { action: p.action },
      });
    }
    let seq = 0;
    for (const call of turn.toolCalls) {
      seq += 1;
      await tx.query(
        `insert into ai_tool_call (id, interaction_id, user_id, seq, tool, args, outcome, row_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uuidv7(realClock.now()),
          turn.id,
          actor.id,
          seq,
          call.tool,
          JSON.stringify(call.args ?? {}),
          call.outcome,
          call.rowCount,
        ],
      );
    }
  });
}
