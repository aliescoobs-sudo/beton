import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { canonicalAuditEvent } from '../src/modules/platform-security/domain/audit-canonical';
import { readChainRows, verifyAuditChain } from '../src/modules/platform-security/service/audit-chain';
import { testEnv } from './db-env';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 10 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(async () => {
  await app.end();
  await migrator.end();
});

const ownerId = '0190c2a8-0000-7000-8000-000000000001';
const record = (requestId: string) =>
  withRlsContext(app, { userId: ownerId, role: 'owner', requestId }, (tx) =>
    tx.query(`select audit.record('login', 'app_user', null, null, '{"n": 1}'::jsonb, 'تجربة')`),
  );

async function verify() {
  const client = await migrator.connect();
  try {
    return await verifyAuditChain(client);
  } finally {
    client.release();
  }
}

describe('audit hash chain (AC-SEC-08)', () => {
  it('every event links to the previous one and its hash recomputes in TypeScript', async () => {
    await record(`chain-${randomUUID()}`);
    await record(`chain-${randomUUID()}`);
    const result = await verify();
    expect(result).toMatchObject({ ok: true });
    expect(result.checked).toBeGreaterThanOrEqual(2);
  });

  it('stays valid under 100 concurrent writers, in under 2 seconds', async () => {
    const started = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 100 }, () => record(`parallel-${randomUUID()}`)));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(2000);
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('refuses to append from a transaction that is not READ COMMITTED (stale snapshot would fork the chain)', async () => {
    const client = await app.connect();
    try {
      await client.query('begin isolation level repeatable read');
      await client.query(`select set_config('app.user_id', $1, true)`, [ownerId]);
      await expect(
        client.query(`select audit.record('login', 'app_user', null, null, null, null)`),
      ).rejects.toThrow(/read committed/i);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('detects an event altered behind the triggers by a superuser, and names it', async () => {
    const requestId = `tamper-${randomUUID()}`;
    await record(requestId);
    const { rows } = await migrator.query('select id, reason from audit_event where request_id = $1', [
      requestId,
    ]);
    const target = rows[0];

    const superuser = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
    await superuser.connect();
    const setReason = async (reason: string) => {
      await superuser.query('alter table audit_event disable trigger audit_event_no_update_delete');
      await superuser.query('update audit_event set reason = $1 where id = $2', [reason, target.id]);
      await superuser.query('alter table audit_event enable trigger audit_event_no_update_delete');
    };
    try {
      await setReason('tampered');
      expect(await verify()).toEqual({
        ok: false,
        checked: expect.any(Number),
        brokenId: target.id,
        problem: 'hash',
      });
    } finally {
      await setReason(target.reason); // restore so the rest of this run sees a valid chain
      await superuser.end();
    }
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('SQL and TypeScript produce the same canonical form', async () => {
    const { rows } = await migrator.query(
      `select audit.canonical(e) as sql_canonical, e.id::text as id from audit_event e order by e.id desc limit 5`,
    );
    const client = await migrator.connect();
    try {
      const tsRows = await readChainRows(client, BigInt(rows.at(-1).id) - 1n, 5);
      for (const row of tsRows) {
        const sql = rows.find((r) => r.id === row.id)?.sql_canonical;
        expect(canonicalAuditEvent(row)).toBe(sql);
      }
    } finally {
      client.release();
    }
  });
});
