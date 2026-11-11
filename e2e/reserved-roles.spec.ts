import { type APIRequestContext, expect, request as playwrightRequest, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { E2E_DATABASE } from '../scripts/db-bootstrap';
import { uuidv7 } from '../src/lib/uuidv7';
import { realClock } from '../src/modules/clock';
import { testEnv } from '../tests/db-env';
import { E2E_BASE_URL } from './fixtures';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security/auth/actors';
import { createAuth } from '../src/modules/platform-security/auth/create-auth';
import { createUser } from '../src/modules/platform-security/auth/user-service';

// R18 group 4E: the guarantee at the PAGE level. The reserved roles (partner, support) have no usable account in V1. Here an identity of each is created through
// the privileged path (the migrator: the application's logins cannot), with (1) a PRE-EXISTING cookie — the session of an ordinary account that later became
// reserved — and (2) an UPGRADE cookie — the session an installation from before this version still holds for an account that is already reserved. Every
// protected page route and every non-public API route of the application is then requested with each cookie: none may answer with content.
const env = testEnv(E2E_DATABASE);
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
test.afterAll(async () => {
  // leave the shared e2e database admissible (no usable reserved account), and no session of the identities
  await migrator.query(
    `delete from "session" where "userId" in (select id from "user" where email like 'e2e-reserved-%')`,
  );
  await migrator.query(`update "user" set status = 'disabled' where email like 'e2e-reserved-%'`);
  await migrator.end();
});

const authPool = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
test.afterAll(() => authPool.end());
const PASSWORD = 'correct-horse-battery-staple';

/**
 * An ordinary account with a REAL session: created like the other e2e users, signed in over HTTP (password; the session cookie the server issued), and then
 * marked as having its second factor so that its pages are the authenticated ones. Its `role` is changed afterwards by the privileged path.
 */
async function identity(label: string, role: string): Promise<{ id: string; cookie: string; email: string }> {
  const email = `e2e-reserved-${label}-${randomUUID().slice(0, 8)}@kayas.test`;
  const auth = createAuth({ authPool, env: { ...env, APP_BASE_URL: E2E_BASE_URL } });
  const made = await createUser(auth, authPool, {
    actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
    email,
    name: `Reserved ${label}`,
    password: PASSWORD,
    role: 'app_admin',
    locale: 'fr',
  });
  const login = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  const res = await login.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
    headers: { origin: E2E_BASE_URL },
  });
  expect(res.status(), 'the ordinary account signs in').toBe(200);
  const cookie = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value.split(';')[0]!)
    .join('; ');
  expect(cookie).toContain('session_token');
  await login.dispose();
  await migrator.query(`update "user" set "twoFactorEnabled" = true where id = $1`, [made.id]);
  await migrator.query(`update "session" set "twoFactorAt" = now() where "userId" = $1`, [made.id]);
  if (role !== 'app_admin')
    await migrator.query(`update "user" set role = $2 where id = $1`, [made.id, role]);
  return { id: made.id, cookie, email };
}

/** A request context that sends THIS cookie (extra headers; the context's own jar would drop a __Host- cookie on plain http). */
const contexts = new Map<string, Promise<APIRequestContext>>();
const as = (cookie: string): Promise<APIRequestContext> => {
  if (!contexts.has(cookie))
    contexts.set(
      cookie,
      playwrightRequest.newContext({ baseURL: E2E_BASE_URL, extraHTTPHeaders: { cookie } }),
    );
  return contexts.get(cookie)!;
};

/** Every protected page and every non-public API route of the application, from the source tree (a new route is swept without anyone remembering it). */
function routes(): { pages: string[]; api: string[] } {
  const UUID = '0194a8a0-0000-7000-8000-000000000001';
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  const toUrl = (rel: string) =>
    rel
      .split('/')
      .filter((seg) => !/^\(.*\)$/.test(seg))
      .map((seg) =>
        seg === '[locale]' ? 'fr' : /^\[\[?\.\.\./.test(seg) ? 'x' : /^\[.*\]$/.test(seg) ? UUID : seg,
      )
      .join('/');
  const pages = walk('src/app/[locale]/(protected)')
    .filter((f) => /\/page\.tsx$/.test(f))
    .map((f) =>
      `/${toUrl(f.replace('src/app/', '').replace(/\/page\.tsx$/, ''))}`.replace(/^\/\[locale\]/, '/fr'),
    );
  const api = walk('src/app/api')
    .filter((f) => /\/route\.ts$/.test(f))
    .filter((f) => !/@permission\s+(public|none)/.test(readFileSync(f, 'utf8')))
    .filter((f) => !/\/api\/auth\//.test(f)) // Better Auth's own endpoints are swept separately below
    .map((f) => `/${toUrl(f.replace('src/app/', '').replace(/\/route\.ts$/, ''))}`);
  return { pages: [...new Set(pages)].sort(), api: [...new Set(api)].sort() };
}

const DENIED = (status: number) =>
  status === 401 || status === 403 || status === 404 || status === 405 || (status >= 300 && status < 400);

test.describe.configure({ mode: 'serial' });

test('the sweep reaches real content: a valid app_admin cookie gets pages (so a denial below means something)', async () => {
  const { pages } = routes();
  expect(pages.length).toBeGreaterThan(40);
  const admin = await identity('control', 'app_admin');
  let ok = 0;
  for (const p of pages.slice(0, 60)) {
    const res = await (await as(admin.cookie)).get(p, { maxRedirects: 0 });
    if (res.status() === 200) ok++;
  }
  expect(ok).toBeGreaterThan(10);
});

for (const role of ['partner', 'support'] as const) {
  test(`${role}: a PRE-EXISTING cookie (the account was an ordinary one when it signed in) stops working everywhere once the account is reserved`, async ({
    request,
  }) => {
    const who = await identity(`pre-${role}`, 'app_admin');
    const { pages, api } = routes();
    // before the change the cookie is good
    const before = await (await as(who.cookie)).get('/fr', { maxRedirects: 0 });
    expect(before.status(), 'the cookie works while the account is an ordinary one').toBe(200);
    await migrator.query(`update "user" set role = $2 where id = $1`, [who.id, role]); // the privileged change
    const leaks: string[] = [];
    for (const p of [...pages, ...api]) {
      const res = await (await as(who.cookie)).get(p, { maxRedirects: 0 });
      if (!DENIED(res.status())) leaks.push(`${p} -> ${res.status()}`);
      if (res.status() >= 300 && res.status() < 400)
        expect(res.headers()['location'] ?? '', p).toMatch(/login|sign-?in|\/fr\/?$/);
    }
    expect(leaks).toEqual([]);
    // the raw Better Auth session endpoint answers nothing and the session is revoked
    const raw = await (await as(who.cookie)).get('/api/auth/get-session');
    expect(await raw.text()).not.toContain(who.id);
    expect((await migrator.query('select 1 from "session" where "userId" = $1', [who.id])).rowCount).toBe(0);
  });

  test(`${role}: an UPGRADE cookie (a session an installation from before this version still holds for an already-reserved account) is refused everywhere`, async ({
    request,
  }) => {
    // a session minted while the account was an ordinary one, MOVED by the privileged path onto an account that is already reserved: what an installation
    // from before this version holds (the application's own logins cannot do this: a trigger refuses it, tests/r18-03-reserved-boundary.int.test.ts)
    const ordinary = await identity(`up-${role}`, 'app_admin');
    const reservedId = uuidv7(realClock.now());
    await migrator.query(
      `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
       values ($1, $2, $3, true, $4, 'fr', 'active', true, now())`,
      [reservedId, `Reserved ${role}`, `e2e-reserved-held-${reservedId}@kayas.test`, role],
    );
    await migrator.query(`update "session" set "userId" = $2 where "userId" = $1`, [ordinary.id, reservedId]);
    const who = { id: reservedId, cookie: ordinary.cookie };
    const { pages, api } = routes();
    const leaks: string[] = [];
    for (const p of [...pages, ...api]) {
      const res = await (await as(who.cookie)).get(p, { maxRedirects: 0 });
      if (!DENIED(res.status())) leaks.push(`${p} -> ${res.status()}`);
    }
    expect(leaks).toEqual([]);
    for (const path of ['/api/auth/get-session']) {
      const res = await (await as(who.cookie)).get(path);
      expect(await res.text()).not.toContain(who.id);
    }
    expect((await migrator.query('select 1 from "session" where "userId" = $1', [who.id])).rowCount).toBe(0);
  });
}

test('a reserved account cannot sign in with its password either (the session hook refuses it): no session cookie is issued', async () => {
  const email = `e2e-reserved-login-${randomUUID().slice(0, 8)}@kayas.test`;
  const auth = createAuth({ authPool, env: { ...env, APP_BASE_URL: E2E_BASE_URL } });
  const made = await createUser(auth, authPool, {
    actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
    email,
    name: 'Reserved login',
    password: PASSWORD,
    role: 'app_admin',
    locale: 'fr',
  });
  await migrator.query(`update "user" set role = 'support' where id = $1`, [made.id]);
  const api = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  const res = await api.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
    headers: { origin: E2E_BASE_URL },
  });
  expect((res.headers()['set-cookie'] ?? '').includes('session_token')).toBe(false);
  expect((await migrator.query('select 1 from "session" where "userId" = $1', [made.id])).rowCount).toBe(0);
  await api.dispose();
});
