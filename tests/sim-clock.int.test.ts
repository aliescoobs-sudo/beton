import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { superuserUrl, TEST_DATABASE } from '../scripts/db-bootstrap';
import { withRlsContext } from '../src/lib/db/rls-context';
import { loadRequestClock, SimulationDisabledError, setSimNow, syncSimClock } from '../src/modules/clock';
import { SYSTEM_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { testEnv } from './db-env';
import { realActor } from './helpers/actors';
import { resetSimClock } from './helpers/reset-sim-clock';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 1 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(async () => {
  await resetSimClock();
  await Promise.all([app.end(), auth.end(), system.end(), migrator.end()]);
});
beforeEach(resetSimClock);

const d1 = new Date('2026-11-23T07:00:00Z');
const d2 = new Date('2026-11-24T07:00:00Z');
const owner = { role: 'owner' as const };

async function ownerActor() {
  return { userId: (await realActor(env.DATABASE_URL_MIGRATOR, 'owner')).id, ...owner };
}

describe('simulation disabled (AC-CLK-01)', () => {
  it('uses real time and never reads the table', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    const clock = await loadRequestClock(auth, false);
    expect(clock.simulated).toBe(false);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('setSimNow throws', async () => {
    await expect(setSimNow(app, false, await ownerActor(), d2, d1)).rejects.toBeInstanceOf(
      SimulationDisabledError,
    );
  });

  it('turning simulation off at boot flips a simulated clock back to real', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    await syncSimClock(system, false, SYSTEM_ACTOR_ID, d2);
    const { rows } = await migrator.query(`select mode from sim_clock`);
    expect(rows).toEqual([{ mode: 'real' }]);
  });
});

describe('simulation enabled', () => {
  it('boot creates the singleton at the real instant; the request clock is frozen on sim_now', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    const clock = await loadRequestClock(auth, true);
    expect(clock.simulated).toBe(true);
    expect(clock.now().toISOString()).toBe(d1.toISOString());
    expect(clock.today()).toBe('2026-11-23');
  });

  it('a second boot does not move an existing simulated clock', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    await setSimNow(app, true, await ownerActor(), d2, d1);
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    expect((await loadRequestClock(auth, true)).now().toISOString()).toBe(d2.toISOString());
  });

  it('moves forward for the owner and refuses a non-owner at the database', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    const office = await realActor(env.DATABASE_URL_MIGRATOR, 'office');
    await setSimNow(app, true, await ownerActor(), d2, d1);
    const denied = await withRlsContext(app, { userId: office.id, role: 'office', requestId: 'r' }, (tx) =>
      tx.query(`update sim_clock set sim_now = $1`, [new Date('2026-12-01T00:00:00Z')]),
    );
    expect(denied.rowCount).toBe(0);
    expect((await loadRequestClock(auth, true)).now().toISOString()).toBe(d2.toISOString());
  });

  it('refuses to move backwards, in the service and in the database (AC-CLK-05)', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d2);
    await expect(setSimNow(app, true, await ownerActor(), d1, d2)).rejects.toThrow(/forward/);
    await expect(
      withRlsContext(system, { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: 'r' }, (tx) =>
        tx.query(`update sim_clock set sim_now = $1`, [d1]),
      ),
    ).rejects.toThrow(/backwards/);
    // Even a superuser (RLS bypassed) cannot rewind: the trigger is the last line.
    const superuser = new pg.Client({ connectionString: superuserUrl(env, TEST_DATABASE) });
    await superuser.connect();
    try {
      await expect(superuser.query(`update sim_clock set sim_now = $1`, [d1])).rejects.toThrow(/backwards/);
    } finally {
      await superuser.end();
    }
  });
});

describe('audit stamping (AC-SEC-08, sim part)', () => {
  const sample = (pool: pg.Pool, userId: string, role: 'owner' | 'anonymous') =>
    withRlsContext(pool, { userId, role, requestId: 'sim-audit' }, async (tx) => {
      await tx.query(`select audit.record('export', 'sim_probe', null, null, null, 'sim-audit')`);
      const { rows } = await tx.query<{ sim_at: Date | null }>(`select ctx.sim_at() as sim_at`);
      return rows[0]!.sim_at;
    });

  it('stamps sim_at on every context, including anonymous, without the caller passing it', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    const ownerId = (await ownerActor()).userId;
    expect((await sample(app, ownerId, 'owner'))?.toISOString()).toBe(d1.toISOString());
    expect((await sample(app, '00000000-0000-7000-8000-000000000000', 'anonymous'))?.toISOString()).toBe(
      d1.toISOString(),
    );
    const { rows } = await migrator.query(
      `select sim_at from audit_event where reason = 'sim-audit' order by id desc limit 2`,
    );
    expect(rows.map((r) => r.sim_at.toISOString())).toEqual([d1.toISOString(), d1.toISOString()]);
  });

  it('leaves sim_at empty in real mode', async () => {
    expect(await sample(app, (await ownerActor()).userId, 'owner')).toBeNull();
  });

  it('changing sim_now is itself audited with its sim_at', async () => {
    await syncSimClock(system, true, SYSTEM_ACTOR_ID, d1);
    await setSimNow(app, true, await ownerActor(), d2, d1);
    const { rows } = await migrator.query(
      `select sim_at, before->>'sim_now' as b, after->>'sim_now' as a from audit_event
        where table_name = 'sim_clock' and action = 'update' order by id desc limit 1`,
    );
    expect(rows[0].b).toBeTruthy();
    expect(new Date(rows[0].a).toISOString()).toBe(d2.toISOString());
    expect(rows[0].sim_at.toISOString()).toBe(d1.toISOString());
  });
});
