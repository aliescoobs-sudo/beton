import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import {
  ANONYMOUS_ACTOR_ID,
  BOOTSTRAP_ACTOR_ID,
  SYSTEM_ACTOR_ID,
} from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import { realActor, type TestActor } from './helpers/actors';

// DECISIONS 76: the database checks the request role against the user's stored role.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

let office: TestActor;
beforeAll(async () => {
  office = await realActor(env.DATABASE_URL_MIGRATOR, 'office');
});

const roleAs = (userId: string, role: never | string) =>
  withRlsContext(app, { userId, role: role as never, requestId: 'ctx-role' }, (tx) =>
    tx.query<{ role: string }>('select ctx.role() as role'),
  ).then((r) => r.rows[0]?.role);

describe('ctx.role() checks the stored role (DECISIONS 76)', () => {
  it('accepts a user acting with their own role', async () => {
    expect(await roleAs(office.id, 'office')).toBe('office');
  });

  it('aborts when the app claims a role the user does not have', async () => {
    await expect(roleAs(office.id, 'owner')).rejects.toThrow(/does not match/);
  });

  it('aborts for an unknown user', async () => {
    await expect(roleAs(uuidv7(realClock.now()), 'partner')).rejects.toThrow(/does not match/);
  });

  it('aborts for a disabled user', async () => {
    const plant = await realActor(env.DATABASE_URL_MIGRATOR, 'plant');
    await migrator.query(`update "user" set status = 'disabled' where id = $1`, [plant.id]);
    await expect(roleAs(plant.id, 'plant')).rejects.toThrow(/does not match/);
  });

  it('allows the system role only for the system and bootstrap actors', async () => {
    expect(await roleAs(SYSTEM_ACTOR_ID, 'system')).toBe('system');
    expect(await roleAs(BOOTSTRAP_ACTOR_ID, 'system')).toBe('system');
    await expect(roleAs(office.id, 'system')).rejects.toThrow(/does not match/);
  });

  it('allows the anonymous role only for the anonymous actor', async () => {
    expect(await roleAs(ANONYMOUS_ACTOR_ID, 'anonymous')).toBe('anonymous');
    await expect(roleAs(office.id, 'anonymous')).rejects.toThrow(/does not match/);
  });

  it('a mismatched role cannot read through RLS or write to the audit log', async () => {
    await expect(
      withRlsContext(app, { userId: office.id, role: 'owner', requestId: 'ctx-role' }, (tx) =>
        tx.query('select count(*) from audit_event'),
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      withRlsContext(app, { userId: office.id, role: 'owner', requestId: 'ctx-role' }, (tx) =>
        tx.query(`select audit.record('export', 'x', null, null, null, null)`),
      ),
    ).rejects.toThrow(/does not match/);
  });

  it('outside a request context the role is simply absent', async () => {
    const { rows } = await app.query('select ctx.role() as role');
    expect(rows[0].role).toBeNull();
  });
});
