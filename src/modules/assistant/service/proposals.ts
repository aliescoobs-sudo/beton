import type pg from 'pg';
import { asAiConfirmation, inRequest, recordAuditEvent, type SessionUser } from '@/modules/platform-security';
import { needsStepUp, type ProposalCard, type StoredDraft } from '../domain/drafts';
import type { PayloadCipher } from './cipher';
import { findDraftTool } from './drafts/registry';
import type { DraftError } from './drafts/types';

export interface ProposalDeps {
  appPool: pg.Pool;
  cipher: PayloadCipher;
  /** The business date. */
  today: string;
}

interface Row {
  id: string;
  action: string;
  status: ProposalCard['status'];
  expires_at: string;
  result_ref: string | null;
  params_enc: string | null;
}

interface Payload {
  stored: StoredDraft;
  card: Omit<ProposalCard, 'id' | 'status' | 'expiresAt' | 'resultRef'>;
}

const COLUMNS = `id, action, status, to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at, result_ref, params_enc`;

function open(deps: ProposalDeps, row: Row): { payload: Payload; card: ProposalCard } | null {
  if (!row.params_enc) return null;
  try {
    const payload = JSON.parse(deps.cipher.open(row.params_enc)) as Payload;
    return {
      payload,
      card: {
        ...payload.card,
        id: row.id,
        status: row.status,
        expiresAt: row.expires_at,
        resultRef: row.result_ref,
      },
    };
  } catch {
    return null;
  }
}

/** A draft nobody confirmed within its 24 hours is expired, once, by the next person-side call. */
async function expireStale(deps: ProposalDeps, actor: SessionUser): Promise<void> {
  await inRequest(deps.appPool, actor, (tx) =>
    tx.query(
      `update ai_proposal set status = 'expired', decided_at = now()
        where user_id = $1 and status = 'pending' and expires_at <= now()`,
      [actor.id],
    ),
  );
}

/** The cards of the person's drafts of the last day, newest first. Nobody else's: the table is theirs alone. */
export async function listProposals(deps: ProposalDeps, actor: SessionUser): Promise<ProposalCard[]> {
  await expireStale(deps, actor);
  const { rows } = await inRequest(deps.appPool, actor, (tx) =>
    tx.query<Row>(
      `select ${COLUMNS} from ai_proposal where user_id = $1 and created_at > now() - interval '24 hours' order by created_at desc limit 20`,
      [actor.id],
    ),
  );
  return rows.flatMap((r) => open(deps, r)?.card ?? []);
}

export type ConfirmError =
  'NOT_FOUND' | 'ALREADY_DECIDED' | 'EXPIRED' | 'STEP_UP_REQUIRED' | 'STALE' | 'FAILED';

export type ConfirmResult =
  { ok: true; card: ProposalCard } | { ok: false; error: ConfirmError; detail?: DraftError };

const load = (deps: ProposalDeps, actor: SessionUser, id: string) =>
  inRequest(deps.appPool, actor, async (tx) => {
    try {
      return (await tx.query<Row>(`select ${COLUMNS} from ai_proposal where id = $1`, [id])).rows[0] ?? null;
    } catch (error) {
      if ((error as { code?: string }).code === '22P02') return null;
      throw error;
    }
  });

/**
 * Confirms a draft (SPEC-assistant §7). Only its owner, once, while it is pending and not expired; a draft that writes a money
 * record needs `stepUpOk` (the route passes it only inside the second-factor guard) or nothing is written. The claim
 * (pending to confirming) is one atomic update, so a second click, a second tab or a replay finds it taken. The service then runs
 * with the human as actor, inside the context that makes the audit trail say `ai_confirmed` and name the proposal; a draft whose
 * data moved under it (the BL is already invoiced, the client archived) fails closed: nothing is written and it is marked failed.
 */
export async function confirmProposal(
  deps: ProposalDeps,
  actor: SessionUser,
  id: string,
  opts: { stepUpOk: boolean },
): Promise<ConfirmResult> {
  await expireStale(deps, actor);
  const row = await load(deps, actor, id);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (row.status === 'expired') return { ok: false, error: 'EXPIRED' };
  if (row.status !== 'pending') return { ok: false, error: 'ALREADY_DECIDED' };
  const opened = open(deps, row);
  const tool = findDraftTool(row.action);
  if (!opened || !tool || !tool.roles.includes(actor.role)) return { ok: false, error: 'NOT_FOUND' };
  if (needsStepUp(tool.name) && !opts.stepUpOk) return { ok: false, error: 'STEP_UP_REQUIRED' };

  const claimed = await inRequest(deps.appPool, actor, async (tx) => {
    try {
      const r = await tx.query(
        `update ai_proposal set status = 'confirming', decided_at = now() where id = $1 and status = 'pending'`,
        [id],
      );
      return (r.rowCount ?? 0) === 1;
    } catch (error) {
      // The guard refuses an expired draft and any move that is not allowed: the draft was not claimed.
      if ((error as { code?: string }).code === '23514') return false;
      throw error;
    }
  });
  if (!claimed) return { ok: false, error: 'ALREADY_DECIDED' };

  const finish = async (status: 'confirmed' | 'failed', ref: string | null, detail: string) => {
    await asAiConfirmation(id, () =>
      inRequest(deps.appPool, actor, async (tx) => {
        await tx.query(`update ai_proposal set status = $2, result_ref = $3 where id = $1`, [
          id,
          status,
          ref,
        ]);
        await recordAuditEvent(tx, {
          action: 'ai_confirmation',
          table: 'ai_proposal',
          rowId: id,
          after: { action: row.action, outcome: status, detail },
        });
      }),
    );
  };

  let result;
  try {
    result = await asAiConfirmation(id, () =>
      tool.execute({ appPool: deps.appPool, actor, today: deps.today }, opened.payload.stored),
    );
  } catch (error) {
    await finish('failed', null, 'error');
    throw error;
  }
  if (!result.ok) {
    await finish('failed', null, result.error);
    return { ok: false, error: result.error === 'STALE' ? 'STALE' : 'FAILED', detail: result.error };
  }
  await finish('confirmed', result.value.ref, 'ok');
  const done = await load(deps, actor, id);
  const card = done ? open(deps, done)?.card : undefined;
  return card ? { ok: true, card } : { ok: false, error: 'NOT_FOUND' };
}

/** "Refuser": the draft is rejected, by its owner, while it is pending. Nothing else happens. */
export async function rejectProposal(
  deps: ProposalDeps,
  actor: SessionUser,
  id: string,
): Promise<ConfirmResult> {
  await expireStale(deps, actor);
  const row = await load(deps, actor, id);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (row.status === 'expired') return { ok: false, error: 'EXPIRED' };
  if (row.status !== 'pending') return { ok: false, error: 'ALREADY_DECIDED' };
  const done = await inRequest(deps.appPool, actor, async (tx) => {
    const r = await tx.query(
      `update ai_proposal set status = 'rejected', decided_at = now() where id = $1 and status = 'pending'`,
      [id],
    );
    if ((r.rowCount ?? 0) === 1)
      await recordAuditEvent(tx, {
        action: 'ai_confirmation',
        table: 'ai_proposal',
        rowId: id,
        after: { action: row.action, outcome: 'rejected' },
      });
    return (r.rowCount ?? 0) === 1;
  });
  if (!done) return { ok: false, error: 'ALREADY_DECIDED' };
  const after = await load(deps, actor, id);
  const card = after ? open(deps, after)?.card : undefined;
  return card ? { ok: true, card } : { ok: false, error: 'NOT_FOUND' };
}

/** The action of one of the person's own drafts, or null: the route needs it to know whether a second factor is asked. */
export async function proposalAction(
  deps: ProposalDeps,
  actor: SessionUser,
  id: string,
): Promise<string | null> {
  const row = await load(deps, actor, id);
  return row ? row.action : null;
}
