import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
afterAll(async () => {
  await app.end();
  await migrator.end();
});

// A real owner: the database checks the request role against the stored role (DECISIONS 76).
let ownerId = '';
beforeAll(async () => {
  ownerId = (await realActor(env.DATABASE_URL_MIGRATOR, 'owner')).id;
});

async function recordAsOwner(requestId: string, action = 'login') {
  return withRlsContext(app, { userId: ownerId, role: 'owner', requestId }, (tx) =>
    tx.query(`select audit.record($1, 'app_user', $2, null, '{"display_name":"Owner"}'::jsonb, null)`, [
      action,
      ownerId,
    ]),
  );
}

async function eventsFor(requestId: string) {
  const { rows } = await migrator.query('select * from audit_event where request_id = $1 order by id', [
    requestId,
  ]);
  return rows;
}

describe('audit_event is append-only (AC-SEC-07, audit part)', () => {
  const requestId = `immutable-${randomUUID()}`;
  beforeAll(() => recordAsOwner(requestId));

  it.each([
    ['UPDATE', `update audit_event set reason = 'tampered' where request_id = $1`],
    ['DELETE', `delete from audit_event where request_id = $1`],
  ])('%s fails for the migrator (table owner)', async (_verb, sql) => {
    await expect(migrator.query(sql, [requestId])).rejects.toThrow();
    expect(await eventsFor(requestId)).toHaveLength(1);
  });

  it('TRUNCATE fails for the migrator (table owner)', async () => {
    await expect(migrator.query('truncate audit_event')).rejects.toThrow();
    expect(await eventsFor(requestId)).toHaveLength(1);
  });

  it.each([
    ['UPDATE', `update audit_event set reason = 'tampered' where request_id = $1`],
    ['DELETE', `delete from audit_event where request_id = $1`],
    ['TRUNCATE', 'truncate audit_event'],
  ])('%s fails for the app role', async (_verb, sql) => {
    await expect(app.query(sql, sql.includes('$1') ? [requestId] : [])).rejects.toThrow(/permission denied/);
  });

  it('a direct INSERT by the app role is refused', async () => {
    await expect(
      withRlsContext(app, { userId: ownerId, role: 'owner', requestId }, (tx) =>
        tx.query(`insert into audit_event (actor_kind, action, table_name) values ('user', 'login', 'x')`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('audit.record()', () => {
  it('stores a service-level event with the actor and request from the context', async () => {
    const requestId = `record-${randomUUID()}`;
    await recordAsOwner(requestId);
    const [event] = await eventsFor(requestId);
    expect(event).toMatchObject({
      actor_user_id: ownerId,
      actor_kind: 'user',
      action: 'login',
      table_name: 'app_user',
      row_id: ownerId,
      before: null,
      after: { display_name: 'Owner' },
      sim_at: null,
    });
    expect(event.at).toBeInstanceOf(Date);
  });

  it('stores the simulated time when the context has one', async () => {
    const requestId = `record-sim-${randomUUID()}`;
    await withRlsContext(
      app,
      { userId: ownerId, role: 'owner', requestId, simAt: new Date('2026-11-25T10:00:00Z') },
      (tx) => tx.query(`select audit.record('login', 'app_user', null, null, null, null)`),
    );
    const [event] = await eventsFor(requestId);
    expect(event.sim_at.toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });

  it('marks jobs run by the system role as system actions', async () => {
    const requestId = `record-system-${randomUUID()}`;
    await withRlsContext(app, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId }, (tx) =>
      tx.query(`select audit.record('login', 'app_user', null, null, null, null)`),
    );
    const [event] = await eventsFor(requestId);
    expect(event.actor_kind).toBe('system');
  });

  it('refuses to record without an actor in the context', async () => {
    await expect(
      app.query(`select audit.record('login', 'app_user', null, null, null, null)`),
    ).rejects.toThrow(/app\.user_id/);
  });

  it('refuses an unknown action', async () => {
    await expect(recordAsOwner(`bad-action-${randomUUID()}`, 'drop_everything')).rejects.toThrow();
  });
});
