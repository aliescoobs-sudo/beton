import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { parseKeyring } from '../src/lib/crypto/keyring';
import {
  closeFieldSession,
  createFieldAccount,
  loginDriver,
  revokeDriverDevice,
  sessionOfToken,
  setDriverPin,
  verifyFieldToken,
} from '../src/modules/field';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';

/** T10c: the phone's session ends on the SERVER (R15B-02 / gate 5). A copy of the token does not survive the logout, nor a newer login. */
const kit = authTestKit();
const app = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 2 });
const secret = kit.env.AUTH_SECRET;
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret });
const marker = `fr${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let owner: SessionUser;
void parseKeyring;

beforeAll(async () => {
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
});
afterAll(async () => {
  await app.end();
  await kit.close();
});

async function driver() {
  // a free code (other files take codes at random): retried on a clash
  let d: { rows: { id: string; code: string }[] } | null = null;
  for (let i = 0; i < 40 && !d; i++) {
    const no = 1000 + Math.floor(Math.random() * 8999);
    try {
      d = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
        tx.query<{ id: string; code: string }>(
          `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id, code`,
          [`CH-${no}`, `${marker} ${no}`, owner.id],
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  if (!d) throw new Error('no free driver code');
  const row = d.rows[0]!;
  expect((await createFieldAccount(deps(), owner, row.id)).ok).toBe(true);
  expect((await setDriverPin(deps(), owner, { driverId: row.id, pin: '482913' })).ok).toBe(true);
  return row;
}
async function signIn(d: { code: string }, dev: string) {
  const r = await loginDriver(deps(), { code: d.code, pin: '482913', deviceId: dev }, new Date());
  if (!r.ok) throw new Error(r.error);
  const token = verifyFieldToken(secret, r.value.token, Math.floor(Date.now() / 1000))!;
  return { token, raw: r.value.token };
}

describe('server-side revocation of the phone session', () => {
  it('a logout ends the session on the server: a COPY of the token stops working at once, and logging out twice is harmless', async () => {
    const d = await driver();
    const dev = `phone-${randomUUID()}`;
    const { token } = await signIn(d, dev);
    expect(await sessionOfToken({ authPool: kit.authPool }, token)).not.toBeNull();
    const copy = { ...token }; // what a stolen cookie would hold
    expect(await closeFieldSession({ authPool: kit.authPool }, token)).toBe(true);
    expect(await sessionOfToken({ authPool: kit.authPool }, token)).toBeNull();
    expect(await sessionOfToken({ authPool: kit.authPool }, copy)).toBeNull();
    // idempotent: nothing left to end, no error
    expect(await closeFieldSession({ authPool: kit.authPool }, copy)).toBe(false);
    // the same phone signs in again: a new generation works, the old token still does not
    const again = await signIn(d, dev);
    expect(again.token.gen).toBeGreaterThan(token.gen);
    expect(await sessionOfToken({ authPool: kit.authPool }, again.token)).not.toBeNull();
    expect(await sessionOfToken({ authPool: kit.authPool }, token)).toBeNull();
  });

  it('a newer login of the bound phone supersedes the earlier token; a token with a wrong generation is refused', async () => {
    const d = await driver();
    const dev = `phone-${randomUUID()}`;
    const first = await signIn(d, dev);
    const second = await signIn(d, dev);
    expect(await sessionOfToken({ authPool: kit.authPool }, first.token)).toBeNull();
    expect(await sessionOfToken({ authPool: kit.authPool }, second.token)).not.toBeNull();
    expect(
      await sessionOfToken({ authPool: kit.authPool }, { ...second.token, gen: second.token.gen + 1 }),
    ).toBeNull();
    expect(await sessionOfToken({ authPool: kit.authPool }, { ...second.token, gen: 0 })).toBeNull();
  });

  it('a token cannot end another phone’s or another driver’s session', async () => {
    const a = await driver();
    const b = await driver();
    const ta = (await signIn(a, `phone-${randomUUID()}`)).token;
    const tb = (await signIn(b, `phone-${randomUUID()}`)).token;
    expect(await closeFieldSession({ authPool: kit.authPool }, { ...ta, driverId: tb.driverId })).toBe(false);
    expect(await closeFieldSession({ authPool: kit.authPool }, { ...ta, deviceHash: tb.deviceHash })).toBe(
      false,
    );
    expect(await sessionOfToken({ authPool: kit.authPool }, ta)).not.toBeNull();
    expect(await sessionOfToken({ authPool: kit.authPool }, tb)).not.toBeNull();
  });

  it('R18-04: a token of a released phone stays dead after the SAME phone is bound again (new device row, generation back to the old value)', async () => {
    const d = await driver();
    const dev = `phone-${randomUUID()}`;
    const old = await signIn(d, dev);
    expect(await sessionOfToken({ authPool: kit.authPool }, old.token)).not.toBeNull();
    // the owner releases the phone; the same phone signs in again: a NEW device row with the same hash
    expect(await revokeDriverDevice(deps(), owner, d.id)).toBe(true);
    expect(await sessionOfToken({ authPool: kit.authPool }, old.token)).toBeNull();
    const fresh = await signIn(d, dev);
    expect(fresh.token.deviceRowId).not.toBe(old.token.deviceRowId);
    // bring the new row's generation to the value the stolen token carries: before the fix this made the old cookie live again
    const rows = await kit.migrator.query<{ session_gen: number }>(
      'select session_gen from driver_device where id = $1',
      [fresh.token.deviceRowId],
    );
    expect(rows.rows[0]!.session_gen).toBeGreaterThan(0);
    await kit.migrator.query('update driver_device set session_gen = $2 where id = $1', [
      fresh.token.deviceRowId,
      old.token.gen,
    ]);
    // the stolen token can neither read the day nor close or revoke the replacement session
    expect(await sessionOfToken({ authPool: kit.authPool }, old.token)).toBeNull();
    expect(await closeFieldSession({ authPool: kit.authPool }, old.token)).toBe(false);
    // the replacement is untouched by the attempt (its own generation was set to the old value only to prove the point)
    const same = await kit.migrator.query<{ session_gen: number; revoked_at: Date | null }>(
      'select session_gen, revoked_at from driver_device where id = $1',
      [fresh.token.deviceRowId],
    );
    expect(same.rows[0]).toMatchObject({ session_gen: old.token.gen, revoked_at: null });
    await kit.migrator.query('update driver_device set session_gen = $2 where id = $1', [
      fresh.token.deviceRowId,
      fresh.token.gen,
    ]);
    expect(await sessionOfToken({ authPool: kit.authPool }, fresh.token)).not.toBeNull();
  });

  it('the session functions are executable by the auth login only', async () => {
    const r = await kit.migrator.query<{ name: string; app: boolean; auth: boolean; pub: boolean }>(
      `select p.proname as name, has_function_privilege('belgobeton_app', p.oid, 'EXECUTE') as app,
              has_function_privilege('belgobeton_auth', p.oid, 'EXECUTE') as auth,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub
         from pg_proc p where p.proname in ('field_session_open', 'field_session_check', 'field_session_close')`,
    );
    expect(r.rows).toHaveLength(3);
    for (const f of r.rows) expect(f, f.name).toMatchObject({ app: false, auth: true, pub: false });
  });
});
