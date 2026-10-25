import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import {
  depositInstrumentsIn,
  type InstrumentError,
  instrumentFailure,
  parseDepositInput,
} from '@/modules/ledger';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import {
  alertKey,
  type CashOption,
  type DraftSpec,
  draftOfCollect,
  draftsOfCashOption,
  draftsOfStockOption,
  type EngineParams,
  type InformationalOption,
  type StockOption,
} from '../domain';
import { computeRun } from './run';

const applySchema = z.object({
  alertKey: z.string().min(3).max(300),
  optionId: z.string().min(1).max(600),
  /** The bank account an early deposit goes to. */
  accountId: z.uuid().optional(),
  /** What the owner saw (centimes): if the engine now computes another figure, nothing is applied. */
  expectedGainCentimes: z.number().int().safe().optional(),
});

export type ApplyError = 'INVALID' | 'NOT_FOUND' | 'STALE' | 'ACCOUNT_REQUIRED' | InstrumentError;

export interface AppliedDecision {
  decisionId: string;
  /** Cheques really deposited by this decision (early deposit only). */
  deposited: number;
  draftText: string;
}

interface Chosen {
  kinds: string[];
  coverageBp: number;
  gain: number;
  shortfall: number;
  targetDate: string;
  details: Record<string, unknown>;
  drafts: DraftSpec[];
  deposit: { instrumentIds: string[]; date: string } | null;
}

function chooseCash(option: CashOption, shortfall: number, targetDate: string): Chosen {
  return {
    kinds: option.kind,
    coverageBp: option.coverageBp,
    gain: option.gain,
    shortfall,
    targetDate,
    details: {
      type: 'cash',
      refs: option.refs,
      counterparties: option.counterparties,
      newBalance: option.newBalance,
      lowestAfter: option.lowestAfter,
      newDeficitDates: option.newDeficitDates,
      remainingDeficitDates: option.remainingDeficitDates,
      cost: option.cost,
      presentsPostDated: option.presentsPostDated,
    },
    drafts: draftsOfCashOption(option),
    deposit: option.apply?.type === 'deposit-instruments' ? option.apply : null,
  };
}

const chooseStock = (option: StockOption, targetDate: string): Chosen => ({
  kinds: [option.kind],
  coverageBp: option.coverageBp,
  gain: 0,
  shortfall: 0,
  targetDate,
  details: { type: 'stock', option },
  drafts: draftsOfStockOption(option),
  deposit: null,
});

const chooseCollect = (option: InformationalOption, targetDate: string): Chosen => ({
  kinds: ['COLLECT-OVERDUE'],
  coverageBp: 0,
  gain: 0,
  shortfall: 0,
  targetDate,
  details: { type: 'collect', party: option.partyName, potential: option.potential, items: option.items },
  drafts: [draftOfCollect(option)],
  deposit: null,
});

/**
 * Applies an option the owner confirmed (SPEC §6, A16, A23): the engine recomputes everything from the facts of this
 * moment, finds the option by its id (a figure that changed since he looked, or an option that disappeared, applies
 * nothing), then in ONE transaction records the decision with the numbers computed and the draft message, and, for an
 * early deposit only, presents the cheques through the ledger's own deposit. Nothing is sent to anyone. The route has
 * asked for a fresh second factor (`cash.apply_option`); the database lets only the owner insert (RLS) and audits the rows.
 */
export async function applyOption(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: {
    today: string;
    params: EngineParams;
    /** Words for the drafts, in the owner's language (messages files); the engine supplies only data. */
    renderDrafts: (drafts: DraftSpec[]) => string;
  },
): Promise<Result<AppliedDecision, ApplyError>> {
  await require(appPool, actor, 'cash.decide');
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;

  const run = await computeRun(appPool, actor, deps.today, deps.params);
  const hit = run.hits.find((h) => alertKey(h) === v.alertKey);
  const options = hit ? run.options.get(v.alertKey) : undefined;
  if (!hit || !options) return err('NOT_FOUND');

  let chosen: Chosen | null = null;
  const cash = options.cash;
  const found = cash ? [...cash.ranked, ...cash.others].find((o) => o.id === v.optionId) : undefined;
  if (cash && found) chosen = chooseCash(found, cash.shortfall, cash.targetDate);
  const stock = options.stock.find((o) => o.id === v.optionId);
  if (!chosen && stock) chosen = chooseStock(stock, hit.targetDate);
  if (!chosen && options.collect?.id === v.optionId) chosen = chooseCollect(options.collect, hit.targetDate);
  const info = cash?.informational.find((i) => i.id === v.optionId);
  if (!chosen && info) chosen = chooseCollect(info, hit.targetDate);
  if (!chosen) return err('NOT_FOUND');
  if (v.expectedGainCentimes !== undefined && v.expectedGainCentimes !== chosen.gain) return err('STALE');

  let depositInput: ReturnType<typeof parseDepositInput> | null = null;
  if (chosen.deposit) {
    if (!v.accountId) return err('ACCOUNT_REQUIRED');
    depositInput = parseDepositInput({
      instrumentIds: chosen.deposit.instrumentIds,
      accountId: v.accountId,
      date: chosen.deposit.date,
    });
    if (!depositInput.ok) return err('INVALID');
  }

  const draftText = deps.renderDrafts(chosen.drafts).slice(0, 4000);
  const decisionId = randomUUID();
  try {
    await inRequest(appPool, actor, async (tx) => {
      if (depositInput?.ok) await depositInstrumentsIn(tx, actor, depositInput.value);
      await tx.query(
        `insert into cash_decision (id, alert_key, option_id, kinds, target_date, coverage_bp, gain_centimes, shortfall_centimes,
                                    details, draft_text, decided_on, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          decisionId,
          v.alertKey,
          v.optionId,
          chosen.kinds,
          chosen.targetDate,
          chosen.coverageBp,
          chosen.gain,
          chosen.shortfall,
          JSON.stringify(chosen.details),
          draftText.length > 0 ? draftText : null,
          deps.today,
          actor.id,
        ],
      );
    });
  } catch (error) {
    return err(instrumentFailure(error));
  }
  return ok({ decisionId, deposited: chosen.deposit?.instrumentIds.length ?? 0, draftText });
}

export interface DecisionView {
  id: string;
  alertKey: string;
  optionId: string;
  kinds: string[];
  targetDate: string;
  coverageBp: number;
  gainCentimes: number;
  decidedOn: string;
  draftText: string | null;
  presentsPostDated: boolean;
  deposited: boolean;
}

/** The decisions taken, newest first (owner and support read). */
export async function listDecisions(appPool: pg.Pool, actor: SessionUser): Promise<DecisionView[]> {
  await require(appPool, actor, 'cash.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      alert_key: string;
      option_id: string;
      kinds: string[];
      target_date: string;
      coverage_bp: number;
      gain: string;
      decided_on: string;
      draft_text: string | null;
      details: { presentsPostDated?: boolean };
    }>(
      `select id, alert_key, option_id, kinds, to_char(target_date, 'YYYY-MM-DD') as target_date, coverage_bp,
              gain_centimes::text as gain, to_char(decided_on, 'YYYY-MM-DD') as decided_on, draft_text, details
         from cash_decision order by created_at desc, id desc limit 200`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    alertKey: r.alert_key,
    optionId: r.option_id,
    kinds: r.kinds,
    targetDate: r.target_date,
    coverageBp: r.coverage_bp,
    gainCentimes: Number(r.gain),
    decidedOn: r.decided_on,
    draftText: r.draft_text,
    presentsPostDated: r.details.presentsPostDated === true,
    deposited: r.kinds.includes('DEPOSIT-EARLY'),
  }));
}
