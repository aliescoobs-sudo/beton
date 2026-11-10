import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { parseKeyring } from '../src/lib/crypto/keyring';
import {
  closeFieldSession,
  createFieldAccount,
  loginDriver,
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
let n = 7000 + Math.floor(Math.random() * 900);
void parseKeyring;

beforeAll(async () => {
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
});
afterAll(async () => {
  await app.end();
  await kit.close();
});

async function driver() {
  const no = n++;
  const d = await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
    tx.query<{ id: string; code: string }>(
      `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id, code`,
      [`CH-${no}`, `${marker} ${no}`, owner.id],
    ),
  );
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
