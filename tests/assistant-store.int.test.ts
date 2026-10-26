import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { cipherFrom } from '../src/modules/assistant/service/cipher';
import {
  newInteractionId,
  recordTurn,
  type TurnRecord,
} from '../src/modules/assistant/service/interaction-store';
import { passGate } from '../src/modules/assistant/service/limits';
import { purgePayloads } from '../src/modules/assistant/service/purge';
import {
  asAiConfirmation,
  inRequest,
  recordAuditEvent,
  SYSTEM_ACTOR_ID,
  type SessionUser,
} from '../src/modules/platform-security';
import { verifyAuditChain } from '../src/modules/platform-security/service/audit-chain';
import { setParameter } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// assistant A3: the tables, the gate (kill switches, rate limits, budget), the purge and the audit kind of a confirmation.
// AC-ASSIST-11 (audit kind), 14, 15.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
afterAll(() => Promise.all([app.end(), auth.end(), system.end(), migrator.end()]));

async function verifyChain() {
  const client = await migrator.connect();
  try {
    return await verifyAuditChain(client);
  } finally {
    client.release();
  }
}

const keyring = parseKeyring(`t1:${Buffer.alloc(32, 5).toString('base64')}`);
const cipher = cipherFrom(keyring);
const hmacKey = Buffer.alloc(32, 6).toString('base64');
const marker = `as${randomUUID().replace(/-/g, '').slice(0, 10)}`;

const users = {} as Record<'owner' | 'office' | 'plant', SessionUser>;
beforeAll(async () => {
  for (const role of ['owner', 'office', 'plant'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
});

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  id: newInteractionId(),
  locale: 'fr',
  provider: 'fake',
  model: 'fake',
  rawQuestion: `Quels camions chargent aujourd'hui ? ${marker}`,
  maskedQuestion: `Quels camions chargent aujourd'hui ? CLT-001`,
  output: 'Trois livraisons.',
  outcome: 'ok',
  toolCalls: [{ tool: 'deliveries_today', args: { date: '2026-10-26' }, outcome: 'ok', rowCount: 3 }],
  tokensIn: 0,
  tokensOut: 0,
  costMicroUsd: 0,
  latencyMs: 12,
  ...over,
});
const save = (user: SessionUser, t: TurnRecord) => recordTurn(app, user, t, { cipher, hmacKey });
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);

describe('a turn is recorded, sealed and private (AC-ASSIST-14)', () => {
  it('stores the interaction and its tool calls, with the payloads sealed and the raw question as a hash only', async () => {
    const t = turn();
    await save(users.office, t);
    const row = (
      await inCtx(users.office, (tx) =>
        tx.query<{
          question_enc: string;
          output_enc: string;
          question_hash: string;
          tool_call_count: number;
        }>(
          `select question_enc, output_enc, question_hash, tool_call_count from ai_interaction where id = $1`,
          [t.id],
        ),
      )
    ).rows[0]!;
    expect(row.tool_call_count).toBe(1);
    expect(row.question_enc).not.toContain('camions');
    expect(cipher.open(row.question_enc)).toBe(t.maskedQuestion);
    expect(cipher.open(row.output_enc)).toBe('Trois livraisons.');
    expect(row.question_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(marker);
    const calls = await inCtx(users.office, (tx) =>
      tx.query(`select tool, outcome, row_count from ai_tool_call where interaction_id = $1`, [t.id]),
    );
    expect(calls.rows).toEqual([{ tool: 'deliveries_today', outcome: 'ok', row_count: 3 }]);
  });

  it('audits the question and each tool call on the chain', async () => {
    const t = turn();
    await save(users.plant, t);
    const { rows } = await migrator.query<{ table_name: string; action: string; actor_kind: string }>(
      `select table_name, action, actor_kind from audit_event
        where row_id = $1::text or after->>'interaction_id' = $1::text`,
      [t.id],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(['ai_interaction', 'ai_tool_call']);
    expect(rows.every((r) => r.actor_kind === 'user' && r.action === 'insert')).toBe(true);
  });

  it('is private: another user, the owner included, reads none of it', async () => {
    const t = turn();
    await save(users.office, t);
    for (const other of [users.owner, users.plant]) {
      const { rows } = await inCtx(other, (tx) =>
        tx.query(`select 1 from ai_interaction where id = $1`, [t.id]),
      );
      expect(rows).toEqual([]);
    }
  });

  it('cannot be forged for someone else, changed or deleted', async () => {
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(
          `insert into ai_interaction (id, user_id, role, locale, provider, model, question_hash, outcome)
           values (gen_random_uuid(), $1, 'owner', 'fr', 'fake', 'x', repeat('a', 64), 'ok')`,
          [users.owner.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const t = turn();
    await save(users.office, t);
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(`update ai_interaction set outcome = 'refused' where id = $1`, [t.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inCtx(users.office, (tx) => tx.query(`delete from ai_interaction where id = $1`, [t.id])),
    ).rejects.toThrow(/permission denied/);
  });

  it('empties the payloads after the retention and keeps the audit chain verifiable', async () => {
    const old = turn();
    await save(users.office, old);
    // An interaction of long ago: the table is insert-only, so it is written as it would have been then.
    const ancient = uuidv7(new Date('2026-01-05T10:00:00Z'));
    await inCtx(users.office, (tx) =>
      tx.query(
        `insert into ai_interaction (id, user_id, role, locale, provider, model, question_hash, question_enc, output_enc, outcome, created_at)
         values ($1, $2, 'office', 'fr', 'fake', 'fake', repeat('b', 64), $3, $3, 'ok', now() - interval '100 days')`,
        [ancient, users.office.id, cipher.seal('old question')],
      ),
    );
    const before = Number((await migrator.query(`select count(*)::int as n from audit_event`)).rows[0].n);
    const first = await purgePayloads(system);
    expect(first.purged).toBeGreaterThanOrEqual(1);
    const rows = (
      await inCtx(users.office, (tx) =>
        tx.query<{ id: string; question_enc: string | null; payload_purged_at: string | null }>(
          `select id, question_enc, payload_purged_at from ai_interaction where id = any($1)`,
          [[old.id, ancient]],
        ),
      )
    ).rows;
    expect(rows.find((r) => r.id === ancient)).toMatchObject({ question_enc: null });
    expect(rows.find((r) => r.id === ancient)?.payload_purged_at).not.toBeNull();
    expect(rows.find((r) => r.id === old.id)?.question_enc).not.toBeNull();
    expect(
      Number((await migrator.query(`select count(*)::int as n from audit_event`)).rows[0].n),
    ).toBeGreaterThan(before - 1);
    expect(await verifyChain()).toMatchObject({ ok: true });
    expect((await purgePayloads(system)).purged).toBe(0);
  });
});

describe('key rotation reaches the sealed payloads (AC-ASSIST-14)', () => {
  it('lets the system actor re-seal the payloads and nothing else', async () => {
    const t = turn();
    await save(users.plant, t);
    const sys = (fn: (tx: pg.PoolClient) => Promise<unknown>) =>
      withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: marker }, fn);
    await sys((tx) =>
      tx.query(`update ai_interaction set question_enc = $2 where id = $1`, [t.id, cipher.seal('re-sealed')]),
    );
    const { rows } = await inCtx(users.plant, (tx) =>
      tx.query<{ question_enc: string }>(`select question_enc from ai_interaction where id = $1`, [t.id]),
    );
    expect(cipher.open(rows[0]!.question_enc)).toBe('re-sealed');
    await expect(
      sys((tx) => tx.query(`update ai_interaction set outcome = 'refused' where id = $1`, [t.id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('the gate: kill switches, rate limits and budget (AC-ASSIST-15)', () => {
  const gate = (user: SessionUser) => passGate({ authPool: auth, appPool: app, systemPool: system }, user);
  const reset = async () => {
    for (const [key, value] of [
      ['assistant.global_off', 0],
      ['assistant.disabled_roles', ''],
      ['assistant.questions_per_10_min', 20],
      ['assistant.questions_per_day', 200],
      ['assistant.budget_usd_month', 20],
    ] as const)
      await setParameter(app, users.owner, key, value);
  };
  afterEach(reset);

  it('lets a turn through by default', async () => {
    expect((await gate(users.plant)).refusal).toBeNull();
  });

  it('refuses everyone with the global switch and one role with the role switch', async () => {
    await setParameter(app, users.owner, 'assistant.disabled_roles', 'plant,office');
    expect((await gate(users.plant)).refusal).toBe('disabled');
    expect((await gate(users.owner)).refusal).toBeNull();
    await setParameter(app, users.owner, 'assistant.global_off', 1);
    expect((await gate(users.owner)).refusal).toBe('disabled');
  });

  it('refuses the questions beyond the limit in ten minutes, counting the refused ones too', async () => {
    const user = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
    await setParameter(app, users.owner, 'assistant.questions_per_10_min', 3);
    for (let i = 0; i < 3; i += 1) {
      expect((await gate(user)).refusal).toBeNull();
      await save(user, turn());
    }
    expect((await gate(user)).refusal).toBe('rate_limited');
    await save(user, turn({ outcome: 'rate_limited', toolCalls: [] }));
    expect((await gate(user)).refusal).toBe('rate_limited');
    // Another user is not affected.
    expect((await gate(await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office'))).refusal).toBeNull();
  });

  it('stops at the monthly budget, whoever spent it', async () => {
    const spender = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'partner');
    await setParameter(app, users.owner, 'assistant.budget_usd_month', 0);
    expect((await gate(users.office)).refusal).toBe('budget_stop');
    await setParameter(app, users.owner, 'assistant.budget_usd_month', 1);
    const base = (await gate(users.office)).budgetPercent;
    await save(spender, turn({ provider: 'anthropic', costMicroUsd: 850_000 - base * 10_000 }));
    const after = await gate(users.office);
    expect(after.budgetPercent).toBeGreaterThanOrEqual(80);
    await save(spender, turn({ provider: 'anthropic', costMicroUsd: 1_000_000 }));
    expect((await gate(users.office)).refusal).toBe('budget_stop');
  });

  it('keeps the limits stricter than the spec: no parameter above the default', async () => {
    await expect(setParameter(app, users.owner, 'assistant.questions_per_10_min', 21)).rejects.toBeDefined();
    await expect(setParameter(app, users.owner, 'assistant.questions_per_day', 201)).rejects.toBeDefined();
  });
});

describe('a confirmation is told apart in the audit trail (AC-ASSIST-11)', () => {
  it('writes ai_confirmed with the proposal id for everything done inside it, and user outside it', async () => {
    const proposalId = uuidv7(new Date());
    await asAiConfirmation(proposalId, () =>
      inRequest(app, users.owner, (tx) =>
        recordAuditEvent(tx, {
          action: 'ai_confirmation',
          table: 'ai_proposal',
          rowId: proposalId,
          reason: marker,
        }),
      ),
    );
    await inRequest(app, users.owner, (tx) =>
      recordAuditEvent(tx, {
        action: 'ai_confirmation',
        table: 'ai_proposal',
        rowId: proposalId,
        reason: `${marker}-h`,
      }),
    );
    const { rows } = await migrator.query<{
      actor_kind: string;
      request_id: string;
      reason: string;
      actor_user_id: string;
    }>(
      `select actor_kind, request_id, reason, actor_user_id from audit_event where row_id = $1 and table_name = 'ai_proposal' order by id`,
      [proposalId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_kind: 'ai_confirmed', actor_user_id: users.owner.id });
    expect(rows[0]?.request_id).toContain(`|ai:${proposalId}`);
    expect(rows[1]).toMatchObject({ actor_kind: 'user' });
    expect(rows[1]?.request_id).not.toContain('|ai:');
    expect(await verifyChain()).toMatchObject({ ok: true });
  });
});

describe('a proposal moves one way (AC-ASSIST-11)', () => {
  async function draft(user: SessionUser, expiresIn = '1 hour') {
    const t = turn();
    await save(user, t);
    const id = uuidv7(new Date());
    await inCtx(user, (tx) =>
      tx.query(
        `insert into ai_proposal (id, interaction_id, user_id, role, action, params_enc, expires_at)
         values ($1, $2, $3, $4, 'record_return', $5, now() + $6::interval)`,
        [id, t.id, user.id, user.role, cipher.seal('{}'), expiresIn],
      ),
    );
    return id;
  }
  const move = (user: SessionUser, id: string, status: string) =>
    inCtx(user, (tx) =>
      tx.query(`update ai_proposal set status = $2, decided_at = now() where id = $1`, [id, status]),
    );

  it('is claimed once: pending, confirming, confirmed, with the resulting number added once', async () => {
    const id = await draft(users.office);
    expect((await move(users.office, id, 'confirming')).rowCount).toBe(1);
    await expect(move(users.office, id, 'confirming')).rejects.toThrow(/not allowed/);
    expect((await move(users.office, id, 'confirmed')).rowCount).toBe(1);
    await inCtx(users.office, (tx) =>
      tx.query(`update ai_proposal set result_ref = 'FA-2026-00001' where id = $1`, [id]),
    );
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(`update ai_proposal set result_ref = 'FA-2026-00002' where id = $1`, [id]),
      ),
    ).rejects.toThrow(/not allowed/);
    await expect(move(users.office, id, 'rejected')).rejects.toThrow(/not allowed/);
  });

  it('cannot be claimed by another user, or after it expired, and its parameters never change', async () => {
    const id = await draft(users.office);
    expect((await move(users.plant, id, 'confirming')).rowCount).toBe(0);
    expect((await move(users.owner, id, 'confirming')).rowCount).toBe(0);
    await expect(
      inCtx(users.office, (tx) => tx.query(`update ai_proposal set params_enc = 'x' where id = $1`, [id])),
    ).rejects.toThrow(/permission denied/);
    const short = await draft(users.office, '1 second');
    await new Promise((r) => setTimeout(r, 1500));
    await expect(move(users.office, short, 'confirming')).rejects.toThrow(/expired/);
    expect((await move(users.office, short, 'expired')).rowCount).toBe(1);
  });

  it('cannot live more than 24 hours, and is born pending', async () => {
    await expect(draft(users.office, '3 days')).rejects.toThrow(/row-level security/);
    const t = turn();
    await save(users.office, t);
    await expect(
      inCtx(users.office, (tx) =>
        tx.query(
          `insert into ai_proposal (id, interaction_id, user_id, role, action, status, expires_at)
           values (gen_random_uuid(), $1, $2, 'office', 'record_return', 'confirmed', now() + interval '1 hour')`,
          [t.id, users.office.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
