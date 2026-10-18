import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { testEnv } from './db-env';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });

const ownerId = '0190c2a8-0000-7000-8000-000000000001';
const asOwner = <T>(requestId: string, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: ownerId, role: 'owner', requestId }, fn);

beforeAll(async () => {
  // Test-only business table (never in migrations), audited like a real one.
  await migrator.query(`
    create table public.audit_probe (id uuid primary key, label text not null, secret_enc text);
    grant select, insert, update on public.audit_probe to belgobeton_app;
    select audit.attach('public.audit_probe');
  `);
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

async function eventsFor(requestId: string) {
  const { rows } = await migrator.query(
    'select action, table_name, row_id, before, after, actor_user_id from audit_event where request_id = $1 order by id',
    [requestId],
  );
  return rows;
}

describe('audit capture trigger (AC-SEC-06, AC-SEC-08 capture part)', () => {
  it('refuses an insert without app.user_id and stores nothing', async () => {
    const id = randomUUID();
    await expect(app.query(`insert into audit_probe (id, label) values ($1, 'x')`, [id])).rejects.toThrow(
      /app\.user_id/,
    );
    const { rowCount } = await migrator.query('select 1 from audit_probe where id = $1', [id]);
    expect(rowCount).toBe(0);
  });

  it('refuses an update without app.user_id', async () => {
    const id = randomUUID();
    await asOwner(`setup-${id}`, (tx) =>
      tx.query(`insert into audit_probe (id, label) values ($1, 'a')`, [id]),
    );
    await expect(app.query(`update audit_probe set label = 'b' where id = $1`, [id])).rejects.toThrow(
      /app\.user_id/,
    );
  });

  it('records exactly one insert event with the actor and the new row', async () => {
    const id = randomUUID();
    const requestId = `insert-${id}`;
    await asOwner(requestId, (tx) =>
      tx.query(`insert into audit_probe (id, label) values ($1, 'first')`, [id]),
    );
    expect(await eventsFor(requestId)).toEqual([
      {
        action: 'insert',
        table_name: 'audit_probe',
        row_id: id,
        before: null,
        after: { id, label: 'first', secret_enc: null },
        actor_user_id: ownerId,
      },
    ]);
  });

  it('records exactly one update event with before and after', async () => {
    const id = randomUUID();
    await asOwner(`setup-${id}`, (tx) =>
      tx.query(`insert into audit_probe (id, label) values ($1, 'old')`, [id]),
    );
    const requestId = `update-${id}`;
    await asOwner(requestId, (tx) => tx.query(`update audit_probe set label = 'new' where id = $1`, [id]));
    const events = await eventsFor(requestId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'update',
      before: { label: 'old' },
      after: { label: 'new' },
    });
  });

  it('records one event per row for a multi-row insert', async () => {
    const requestId = `multi-${randomUUID()}`;
    await asOwner(requestId, (tx) =>
      tx.query(`insert into audit_probe (id, label) values ($1, 'a'), ($2, 'b'), ($3, 'c')`, [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ]),
    );
    expect(await eventsFor(requestId)).toHaveLength(3);
  });

  it('logs encrypted columns exactly as stored, never decrypted', async () => {
    const id = randomUUID();
    const requestId = `enc-${id}`;
    const ciphertext = 'k1:3q2+7w==:ZmFrZS1jaXBoZXJ0ZXh0';
    await asOwner(requestId, (tx) =>
      tx.query(`insert into audit_probe (id, label, secret_enc) values ($1, 'x', $2)`, [id, ciphertext]),
    );
    const [event] = await eventsFor(requestId);
    expect(event.after.secret_enc).toBe(ciphertext);
  });

  it('writes nothing to the audit log when the business transaction rolls back', async () => {
    const requestId = `rollback-${randomUUID()}`;
    await expect(
      asOwner(requestId, async (tx) => {
        await tx.query(`insert into audit_probe (id, label) values ($1, 'x')`, [randomUUID()]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await eventsFor(requestId)).toEqual([]);
  });

  it('cannot be attached or detached by the app role', async () => {
    await expect(app.query(`select audit.attach('public.audit_probe')`)).rejects.toThrow(/permission denied/);
    await expect(app.query('drop trigger audit_capture on audit_probe')).rejects.toThrow(/owner|permission/);
  });
});

describe('audit.record() refuses to forge data-change events', () => {
  it.each(['insert', 'update'])(
    'rejects action %s, which only the capture trigger may write',
    async (action) => {
      await expect(
        asOwner(`forge-${randomUUID()}`, (tx) =>
          tx.query(`select audit.record($1, 'audit_probe', null, null, null, null)`, [action]),
        ),
      ).rejects.toThrow(/trigger/);
    },
  );
});
