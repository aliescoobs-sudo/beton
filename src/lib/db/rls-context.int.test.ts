import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../../../tests/db-env';
import { realActor } from '../../../tests/helpers/actors';
import { withRlsContext } from './rls-context';

// Pool of one connection: every transaction reuses the same session, so a leak would be visible.
const pool = new pg.Pool({ connectionString: testEnv().DATABASE_URL_APP, max: 1 });
afterAll(() => pool.end());

// A real owner: the database checks the request role against the stored role (DECISIONS 76).
const owner = { userId: '', role: 'owner' as const, requestId: 'req-1' };
beforeAll(async () => {
  owner.userId = (await realActor(testEnv().DATABASE_URL_MIGRATOR, 'owner')).id;
});

async function currentContext(client: pg.PoolClient | pg.Pool) {
  const { rows } = await client.query(
    `select ctx.user_id()::text as user_id, ctx.role() as role, ctx.request_id() as request_id, ctx.sim_at() as sim_at`,
  );
  return rows[0];
}

describe('withRlsContext', () => {
  it('exposes the context to SQL inside the transaction', async () => {
    const seen = await withRlsContext(pool, owner, (tx) => currentContext(tx));
    expect(seen).toEqual({ user_id: owner.userId, role: 'owner', request_id: 'req-1', sim_at: null });
  });

  it('passes simulated time when given', async () => {
    const seen = await withRlsContext(pool, { ...owner, simAt: new Date('2026-11-25T07:00:00Z') }, (tx) =>
      currentContext(tx),
    );
    expect(new Date(seen.sim_at).toISOString()).toBe('2026-11-25T07:00:00.000Z');
  });

  it('does not leak the context to the next use of the same connection', async () => {
    await withRlsContext(pool, owner, async () => undefined);
    expect(await currentContext(pool)).toEqual({ user_id: null, role: null, request_id: null, sim_at: null });
  });

  it('does not leak the context after a failed transaction either', async () => {
    await expect(
      withRlsContext(pool, owner, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await currentContext(pool)).toEqual({ user_id: null, role: null, request_id: null, sim_at: null });
  });

  it('rolls back everything done in the callback when it throws', async () => {
    await expect(
      withRlsContext(pool, owner, async (tx) => {
        // Session-level (not transaction-local) write: only a rollback undoes it.
        await tx.query(`select set_config('app.rollback_probe', 'written', false)`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await pool.query(`select nullif(current_setting('app.rollback_probe', true), '') as v`);
    expect(rows[0].v).toBeNull();
  });

  it('rejects an invalid context before touching the database', async () => {
    await expect(
      withRlsContext(pool, { ...owner, role: 'admin' as never }, async () => 'ran'),
    ).rejects.toThrow(/role/);
    await expect(withRlsContext(pool, { ...owner, userId: 'not-a-uuid' }, async () => 'ran')).rejects.toThrow(
      /userId/,
    );
  });
});
