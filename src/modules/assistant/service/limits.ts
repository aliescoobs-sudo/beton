import type pg from 'pg';
import { readParameters, type SessionUser } from '@/modules/platform-security';
import { withRlsContext } from '@/lib/db/rls-context';
import { SYSTEM_ACTOR_ID } from '@/modules/platform-security';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { budgetPercentUsed } from '../domain/cost';
import type { Outcome } from '../domain/outcome';

export type GateRefusal = Extract<Outcome, 'disabled' | 'rate_limited' | 'budget_stop'>;

export interface GateResult {
  /** Why the turn must not reach a provider, or null. */
  refusal: GateRefusal | null;
  /** Whole percent of the monthly budget used (for the owner's warning at 80 %). */
  budgetPercent: number;
}

/** What the month has cost so far, in micro-dollars, over every user: read as the system actor (no user may read another's rows). */
export async function monthCostMicroUsd(systemPool: pg.Pool): Promise<number> {
  return withRlsContext(
    systemPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: uuidv7(realClock.now()) },
    async (tx) => {
      const { rows } = await tx.query<{ cost: string }>(
        `select coalesce(sum(cost_micro_usd), 0)::text as cost from ai_interaction
          where created_at >= date_trunc('month', now())`,
      );
      return Number(rows[0]?.cost ?? 0);
    },
  );
}

/**
 * The gate every turn passes before anything else (SPEC-assistant §9): the owner's kill switches (global, per role), the per-user
 * rate limits (counted over every turn the user started, refused ones included), and the monthly budget. A refusal is recorded by
 * the caller as the turn's outcome, and no provider is called. The limits are parameters that can only be made stricter.
 */
export async function passGate(
  deps: { authPool: pg.Pool; appPool: pg.Pool; systemPool: pg.Pool },
  actor: SessionUser,
): Promise<GateResult> {
  const params = await readParameters(deps.authPool);
  const spent = await monthCostMicroUsd(deps.systemPool);
  const budgetPercent = budgetPercentUsed(spent, params['assistant.budget_usd_month']);
  if (params['assistant.global_off'] === 1) return { refusal: 'disabled', budgetPercent };
  if (params['assistant.disabled_roles'].split(',').includes(actor.role))
    return { refusal: 'disabled', budgetPercent };
  if (budgetPercent >= 100) return { refusal: 'budget_stop', budgetPercent };

  const counts = await withRlsContext(
    deps.appPool,
    { userId: actor.id, role: actor.role, requestId: uuidv7(realClock.now()) },
    async (tx) => {
      const { rows } = await tx.query<{ ten: string; day: string }>(
        `select count(*) filter (where created_at > now() - interval '10 minutes')::text as ten,
                count(*) filter (where created_at > now() - interval '24 hours')::text as day
           from ai_interaction where user_id = $1`,
        [actor.id],
      );
      return { ten: Number(rows[0]?.ten ?? 0), day: Number(rows[0]?.day ?? 0) };
    },
  );
  if (
    counts.ten >= params['assistant.questions_per_10_min'] ||
    counts.day >= params['assistant.questions_per_day']
  )
    return { refusal: 'rate_limited', budgetPercent };
  return { refusal: null, budgetPercent };
}
