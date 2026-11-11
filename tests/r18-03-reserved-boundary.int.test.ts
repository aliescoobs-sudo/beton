import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superuserUrl } from '../scripts/db-bootstrap';
import { runMigrations } from '../scripts/db-migrate';
import { withRlsContext } from '../src/lib/db/rls-context';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import {
  closeFieldSession,
  createFieldAccount,
  loginDriver,
  sessionOfToken,
  setDriverPin,
  verifyFieldToken,
} from '../src/modules/field';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import {
  AdmissionUnavailableError,
  assertNoUsableReservedAccounts,
  assertReservedBoundaryOn,
  ReservedAccountsError,
  usableReservedAccounts,
} from '../src/modules/platform-security/service/reserved-admission';
import { authTestKit } from './auth-helpers';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { setReservedBoundary } from './setup-db';

/**
 * R18-03: the reserved roles (partner, support) at the database actor boundary (switched ON for this file, as on every server), the auth-session
 * table, raw get-session, the committed cleanup, the startup helper, and the phone's doors for a linked account whose role or status changed.
 */
const env = testEnv();
const kit = authTestKit();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const marker = `r3${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const secret = kit.env.AUTH_SECRET;
let owner: SessionUser;

beforeAll(async () => {
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, true);
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
});
afterAll(async () => {
  await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
  await Promise.all([app.end(), kit.close()]);
});

const RESERVED = ['partner', 'support'] as const;
async function sessionsOf(userId: string) {
  return (await kit.migrator.query('select 1 from "session" where "userId" = $1', [userId])).rowCount ?? 0;
}

describe('R18-03: the database refuses a stored reserved role as an actor', () => {
  it.each(RESERVED)(
    '%s: ctx.actor_role, the order view and the invoice queue refuse an ACTIVE reserved account with real SQL; an office account on the same statements is served',
    async (role) => {
      const id = uuidv7(realClock.now());
      await kit.migrator.query(
        `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
         values ($1, $2, $3, true, $4, 'fr', 'active', true, now())`,
        [id, `${marker} ${role}`, `${marker}-${role}-${id}@kayas.test`, role],
      );
      const reads = [
        'select ctx.actor_role()',
        'select count(*) from public.sales_order_ops',
        'select * from public.invoice_queue()',
      ];
      for (const sql of reads) {
        await expect(
          withRlsContext(app, { userId: id, role, requestId: marker }, (tx) => tx.query(sql)),
          `${role}: ${sql}`,
        ).rejects.toMatchObject({ code: '42501' });
      }
      // the control: the same statements as an office account are answered
      const office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office_sales');
      for (const sql of reads.slice(1))
        await withRlsContext(
          app,
          { userId: office.id, role: office.role as never, requestId: marker },
          (tx) => tx.query(sql),
        );
      await kit.migrator.query(`update "user" set status = 'disabled' where id = $1`, [id]);
    },
  );
});

describe('R18-03: sessions and cookies of a reserved account', () => {
  it.each(RESERVED)(
    '%s with a PRE-EXISTING cookie: raw get-session revokes it and answers nothing; the KAYAS gate agrees; the session row is gone and the revocation is audited',
    async (role) => {
      const u = await kit.enrolledUser('office');
      const cookie = u.cookie;
      expect((await kit.getSession(cookie))?.user?.id).toBe(u.id); // a live session
      expect(await sessionsOf(u.id)).toBeGreaterThan(0);
      await kit.migrator.query(`update "user" set role = $2 where id = $1`, [u.id, role]); // a privileged change after start
      // the raw Better Auth path (no KAYAS gate): before the fix it returned the reserved user
      const raw = await kit.auth.handler(
        new Request(`${kit.env.APP_BASE_URL}/api/auth/get-session`, {
          headers: { cookie, origin: kit.env.APP_BASE_URL },
        }),
      );
      const body = (await raw.text()).trim();
      expect(body === '' || body === 'null' || !body.includes(u.id), body).toBe(true);
      expect(await sessionsOf(u.id)).toBe(0);
      expect((await resolveAuthState(kit.auth, new Headers({ cookie }))).kind).toBe('anonymous');
      const ev = await kit.auditEvents(
        `action = 'session_revoked' and reason = 'role_not_usable' and after->>'user_id' = $1`,
        [u.id],
      );
      expect(ev.length).toBeGreaterThanOrEqual(1);
      await kit.migrator.query(`update "user" set role = 'office' where id = $1`, [u.id]);
    },
  );

  it.each(RESERVED)(
    '%s: the auth login cannot RETARGET a live session of an office account onto a reserved account (UPDATE of its user)',
    async (role) => {
      const live = await kit.enrolledUser('office');
      const target = await kit.newUser('office');
      await kit.migrator.query(`update "user" set role = $2, status = 'disabled' where id = $1`, [
        target.id,
        role,
      ]);
      const before = await kit.migrator.query<{ userId: string }>(
        'select "userId" from "session" where "userId" = $1 limit 1',
        [live.id],
      );
      expect(before.rowCount).toBeGreaterThan(0);
      await expect(
        kit.authPool.query(`update "session" set "userId" = $2 where "userId" = $1`, [live.id, target.id]),
      ).rejects.toThrow(/no sessions in V1/);
      expect(await sessionsOf(target.id)).toBe(0);
      expect(await sessionsOf(live.id)).toBeGreaterThan(0);
      // an ordinary update (the session's own expiry) is not blocked
      await kit.authPool.query(`update "session" set "updatedAt" = now() where "userId" = $1`, [live.id]);
    },
  );
});

describe('R18-03: admission — the cleanup is committed apart from the refusal, and a missing function fails', () => {
  it('a failed admission still revokes: the helper and the migration runner both leave NO session of a usable reserved account', async () => {
    const id = uuidv7(realClock.now());
    await kit.migrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
       values ($1, 'R', $2, true, 'support', 'fr', 'active', true, now())`,
      [id, `${marker}-adm-${id}@kayas.test`],
    );
    const addSession = () =>
      kit.migrator.query(
        `insert into "session" (id, "expiresAt", token, "updatedAt", "userId") values ($1, now() + interval '1 hour', $2, now(), $3)`,
        [randomUUID(), randomUUID(), id],
      );
    await addSession();
    await expect(assertNoUsableReservedAccounts(kit.migrator)).rejects.toBeInstanceOf(ReservedAccountsError);
    expect(await sessionsOf(id)).toBe(0); // the refusal did not roll the revocation back
    await addSession();
    await expect(runMigrations(env.DATABASE_URL_MIGRATOR)).rejects.toThrow(/usable account/);
    expect(await sessionsOf(id)).toBe(0);
    await kit.migrator.query(`update "user" set status = 'disabled' where id = $1`, [id]);
  });

  it('the startup helper FAILS (not zero) on a database without the admission function — a real empty database', async () => {
    const name = `r18scratch_${marker}`;
    const sup = new pg.Client({ connectionString: superuserUrl(env, 'postgres') });
    await sup.connect();
    try {
      await sup.query(`create database ${name}`);
      const u = new URL(env.DATABASE_URL_MIGRATOR);
      u.pathname = `/${name}`;
      const scratch = new pg.Pool({ connectionString: u.toString(), max: 1 });
      try {
        await expect(usableReservedAccounts(scratch)).rejects.toBeInstanceOf(AdmissionUnavailableError);
        await expect(assertNoUsableReservedAccounts(scratch)).rejects.toBeInstanceOf(
          AdmissionUnavailableError,
        );
        await expect(assertReservedBoundaryOn(scratch)).rejects.toBeInstanceOf(AdmissionUnavailableError);
      } finally {
        await scratch.end();
      }
    } finally {
      await sup.query(`drop database if exists ${name} with (force)`);
      await sup.end();
    }
  });

  it('the server refuses a database whose boundary is off, and accepts one where it is on', async () => {
    await expect(assertReservedBoundaryOn(kit.migrator)).resolves.toBeUndefined();
    await setReservedBoundary(env.DATABASE_URL_MIGRATOR, false);
    try {
      await expect(assertReservedBoundaryOn(kit.migrator)).rejects.toThrow(/switched off/);
    } finally {
      await setReservedBoundary(env.DATABASE_URL_MIGRATOR, true);
    }
  });
});

describe("R18-03: the phone's doors need an active linked user of the driver's kind", () => {
  const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret });
  async function driver() {
    for (let i = 0; i < 40; i++) {
      const no = 1000 + Math.floor(Math.random() * 8999);
      try {
        const d = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
          tx.query<{ id: string; code: string }>(
            `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id, code`,
            [`CH-${no}`, `${marker} ${no}`, owner.id],
          ),
        );
        const row = d.rows[0]!;
        const made = await createFieldAccount(deps(), owner, row.id);
        if (!made.ok) throw new Error(made.error);
        expect((await setDriverPin(deps(), owner, { driverId: row.id, pin: '482913' })).ok).toBe(true);
        return { ...row, userId: made.value.userId };
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    throw new Error('no free driver code');
  }
  const signIn = (code: string, device: string) =>
    loginDriver(deps(), { code, pin: '482913', deviceId: device }, new Date());

  it.each([
    [
      'disabled',
      (id: string) => kit.migrator.query(`update "user" set status = 'disabled' where id = $1`, [id]),
    ],
    [
      're-roled to partner',
      (id: string) => kit.migrator.query(`update "user" set role = 'partner' where id = $1`, [id]),
    ],
    [
      're-roled to office',
      (id: string) => kit.migrator.query(`update "user" set role = 'office' where id = $1`, [id]),
    ],
  ])(
    'a linked account %s after the phone signed in: the cookie stops working, no new session is issued, and a restored account works again',
    async (_n, change) => {
      const d = await driver();
      const dev = `phone-${randomUUID()}`;
      const first = await signIn(d.code, dev);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const token = verifyFieldToken(secret, first.value.token, Math.floor(Date.now() / 1000))!;
      expect(await sessionOfToken({ authPool: kit.authPool }, token)).not.toBeNull();
      await change(d.userId);
      expect(await sessionOfToken({ authPool: kit.authPool }, token)).toBeNull(); // the cookie of the phone
      const again = await signIn(d.code, dev); // the right PIN, the bound phone
      expect(again.ok).toBe(false);
      expect(await closeFieldSession({ authPool: kit.authPool }, token)).toBe(true); // a logout still ends it (nothing left to work with)
      // restore: the account is a driver account again
      await kit.migrator.query(`update "user" set status = 'active', role = 'driver' where id = $1`, [
        d.userId,
      ]);
      const back = await signIn(d.code, dev);
      expect(back.ok).toBe(true);
    },
  );
});
