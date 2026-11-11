import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createFieldAccount,
  loginDriver,
  sessionOfToken,
  setDriverPin,
  verifyFieldToken,
} from '../src/modules/field';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';

/**
 * R19-04: a phone logout whose server close SUCCEEDED (or whose token was expired or invalid) must not carry a cookie deletion that can arrive after another
 * tab signed in. The real route runs against the real database; the browser is modelled: the cookie the route reads is the one in the store at request
 * time, and the response's header effects are applied to the store only when "released", AFTER the second tab's login.
 */
const kit = authTestKit();
const app = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 2 });
const secret = kit.env.AUTH_SECRET;
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret });
const marker = `lc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let owner: SessionUser;

const browser = { cookie: undefined as string | undefined };
let pendingDeletes = 0; // Set-Cookie deletions the response would apply when it arrives
const clock = { at: Date.now() };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'bb_field' && browser.cookie ? { name, value: browser.cookie } : undefined,
    delete: (name: string) => {
      if (name === 'bb_field') pendingDeletes++;
    },
  }),
}));
vi.mock('@/app/api/field/context', () => ({
  fieldJson: (status: number, body: unknown) => Response.json(body, { status }),
  fieldRoute: async (_r: Request, _o: unknown, run: (c: unknown) => Promise<Response>) =>
    run({ deps: { appPool: app, authPool: kit.authPool, auth: kit.auth, secret } }),
}));
vi.mock('../src/app/api/field/context', () => ({
  fieldJson: (status: number, body: unknown) => Response.json(body, { status }),
  fieldRoute: async (_r: Request, _o: unknown, run: (c: unknown) => Promise<Response>) =>
    run({ deps: { appPool: app, authPool: kit.authPool, auth: kit.auth, secret } }),
}));
vi.mock('@/app/request-clock', () => ({ getRequestClock: async () => ({ now: () => new Date(clock.at) }) }));
vi.mock('@/lib/server-env', () => ({ getEnv: () => ({ AUTH_SECRET: kit.env.AUTH_SECRET }) }));

beforeAll(async () => {
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
});
afterAll(async () => {
  await app.end();
  await kit.close();
});

async function driver() {
  let row: { id: string; code: string } | undefined;
  for (let i = 0; i < 40 && !row; i++) {
    const no = 1000 + Math.floor(Math.random() * 8999);
    try {
      row = (
        await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: marker }, (tx) =>
          tx.query<{ id: string; code: string }>(
            `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id, code`,
            [`CH-${no}`, `${marker} ${no}`, owner.id],
          ),
        )
      ).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  if (!row) throw new Error('no free driver code');
  expect((await createFieldAccount(deps(), owner, row.id)).ok).toBe(true);
  expect((await setDriverPin(deps(), owner, { driverId: row.id, pin: '482913' })).ok).toBe(true);
  return row;
}
const signIn = async (d: { code: string }, dev: string) => {
  const r = await loginDriver(deps(), { code: d.code, pin: '482913', deviceId: dev }, new Date());
  if (!r.ok) throw new Error(r.error);
  return r.value.token;
};

describe('R19-04: a late logout response cannot delete the cookie of a newer sign-in', () => {
  it('successful close: tab A logs out (response held), tab B signs in, the held response is released: B keeps its cookie and its session', async () => {
    const { POST } = await import('../src/app/api/field/logout/route');
    const d = await driver();
    const dev = `phone-${randomUUID()}`;
    browser.cookie = await signIn(d, dev); // tab A's login (the browser cookie is shared by both tabs)
    clock.at = Date.now();
    pendingDeletes = 0;
    const held = await POST(new Request('http://x/api/field/logout', { method: 'POST' })); // the server CLOSED the session; the response is still on its way
    expect(held.status).toBe(200);
    const bCookie = await signIn(d, dev); // tab B signs in meanwhile
    browser.cookie = bCookie;
    // the held response now arrives: whatever cookie header it carries is applied to the shared store
    if (pendingDeletes > 0 || held.headers.get('set-cookie')) browser.cookie = undefined;
    expect(browser.cookie).toBe(bCookie);
    const token = verifyFieldToken(secret, browser.cookie!, Math.floor(Date.now() / 1000))!;
    expect(await sessionOfToken({ authPool: kit.authPool }, token)).not.toBeNull();
  });

  it('expired old token: the logout has nothing to end and still must not delete the shared cookie when it arrives late', async () => {
    const { POST } = await import('../src/app/api/field/logout/route');
    const d = await driver();
    const dev = `phone-${randomUUID()}`;
    browser.cookie = await signIn(d, dev);
    clock.at = Date.now() + 365 * 24 * 3600 * 1000; // the route's trusted time: the token is long expired
    pendingDeletes = 0;
    const held = await POST(new Request('http://x/api/field/logout', { method: 'POST' }));
    expect(held.status).toBe(200);
    clock.at = Date.now();
    const bCookie = await signIn(d, dev);
    browser.cookie = bCookie;
    if (pendingDeletes > 0 || held.headers.get('set-cookie')) browser.cookie = undefined;
    expect(browser.cookie).toBe(bCookie);
    const token = verifyFieldToken(secret, browser.cookie!, Math.floor(Date.now() / 1000))!;
    expect(await sessionOfToken({ authPool: kit.authPool }, token)).not.toBeNull();
  });

  it('the server revocation stands: after the logout, the old token is dead', async () => {
    const { POST } = await import('../src/app/api/field/logout/route');
    const d = await driver();
    const raw = await signIn(d, `phone-${randomUUID()}`);
    browser.cookie = raw;
    clock.at = Date.now();
    await POST(new Request('http://x/api/field/logout', { method: 'POST' }));
    const token = verifyFieldToken(secret, raw, Math.floor(Date.now() / 1000))!;
    expect(await sessionOfToken({ authPool: kit.authPool }, token)).toBeNull();
  });
});
