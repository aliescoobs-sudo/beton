import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { readParameters, setParameter } from '../src/modules/platform-security/service/parameter-service';
import { ForbiddenError } from '../src/modules/platform-security/service/user-admin';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';

const kit = authTestKit();
const appPool = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 2 });
afterAll(async () => {
  await appPool.end();
  await kit.close();
});

let owner: SessionUser;
beforeAll(async () => {
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
});

describe('parameters store (T19)', () => {
  it('returns the defaults until a value is set, then the stored value', async () => {
    expect((await readParameters(kit.authPool))['auth.lockout_window_minutes']).toBe(15);
    await setParameter(appPool, owner, 'auth.lockout_window_minutes', 20);
    expect((await readParameters(kit.authPool))['auth.lockout_window_minutes']).toBe(20);
    await setParameter(appPool, owner, 'auth.lockout_window_minutes', 15);
  });

  it('rejects an invalid or weakening value and stores nothing', async () => {
    await expect(setParameter(appPool, owner, 'auth.step_up_minutes', 60)).rejects.toThrow(/invalid/i);
    expect((await readParameters(kit.authPool))['auth.step_up_minutes']).toBe(10);
  });

  it('audits every change with before and after, under the owner', async () => {
    await setParameter(appPool, owner, 'clock.job.day_close', '20:15');
    await setParameter(appPool, owner, 'clock.job.day_close', '20:00');
    const events = await kit.auditEvents(`table_name = 'parameter' and actor_user_id = $1`, [owner.id]);
    expect(events.at(-1)).toMatchObject({ action: 'update', row_id: 'clock.job.day_close' });
    expect(events.at(-1)!.after.value).toBe('20:00');
  });

  it.each(['partner', 'office', 'plant'] as const)('refuses a write by %s in the service', async (role) => {
    await expect(
      setParameter(
        appPool,
        await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, role),
        'auth.step_up_minutes',
        5,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a partner write at the database level too (RLS), even bypassing the service', async () => {
    const partner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'partner');
    await expect(
      withRlsContext(appPool, { userId: partner.id, role: 'partner', requestId: 'rls-write' }, (tx) =>
        tx.query(
          `insert into parameter (key, value, updated_by, updated_at) values ('auth.step_up_minutes', '5', $1, now())
           on conflict (key) do update set value = excluded.value`,
          [partner.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the lockout follows the stored threshold', async () => {
    await setParameter(appPool, owner, 'auth.lockout_account_failures', 3);
    try {
      const { email } = await kit.newUser('office');
      for (let i = 0; i < 3; i++)
        await kit.call('/sign-in/email', { email, password: `wrong-password-${i}xx` });
      expect((await kit.call('/sign-in/email', { email, password: kit.password })).status).toBe(429);
    } finally {
      await setParameter(appPool, owner, 'auth.lockout_account_failures', 5);
    }
  });
});
