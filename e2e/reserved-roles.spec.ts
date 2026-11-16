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
import {
  cloneSession,
  actionRefused,
  businessWrites,
  denied,
  reached,
  routeInventory,
  send,
  sessionSecret,
  serverActions,
  WRITE_METHODS,
  type Method,
  type RouteRef,
} from './sweep-support';
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

void (null as unknown as RouteRef);
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

// ---- R19 group 3A: write methods, protected PDF/export routes, server actions, a LIVE session per probe, per-target positive controls ---------------------------
// A session is revoked by the first request that meets it once its account is reserved, so every later probe of a shared cookie only proves "anonymous is refused".
// Here EVERY probe gets its own live session of the reserved account (inserted by the privileged path, signed like the server signs it), so each answer is the gate's
// answer to a session that nothing has revoked. 405 counts as a refusal only where the route does not export that method (asserted per route); a method the route
// exports must be denied outright. Each target also has a positive control: an app_admin with its own live session reaches it, or the target is listed as unreachable
// by that control with the reason.
const SECRET = sessionSecret(env as { AUTH_SECRET: string; AUTH_SECRETS?: string });
/** Targets an ordinary admin cannot reach either (the sweep then says nothing about them beyond "denied"), with the reason. Checked for stale entries. */
const BLIND: [RegExp, string][] = [
  [
    / \/api\/field\//,
    'a phone-token door: an office session is not its caller (the phone-token matrices are in role-negatives.spec.ts)',
  ],
  [
    /^GET \/fr\/aging\/export$/,
    'the aging CSV needs ?kind=client or supplier: the sweep sends none, so the control gets 404 too; the known-target check with each office role is in role-negatives.spec.ts (T19c)',
  ],
  [/ \/api\/finance(-configuration)?$/, 'needs a fresh TOTP of its own (a step-up the sweep does not hold)'],
  [/ \/api\/assistant\/proposals\/[^/]+\/(confirm|reject)$/, 'needs an existing proposal of the caller'],
  [
    /^GET \/fr\/(accounting\/export|finance\/export|avoirs|deliveries|documents|invoices|quotes|receipts|statements|supplier-invoices|trips\/bl-photo)/,
    'a PDF, export or file route: the sweep sends a target id that does not exist, so the control gets 404 too; the KNOWN-target matrix with a real invoice, quote and statement is in role-negatives.spec.ts',
  ],
];
const blindReason = (key: string): string | undefined =>
  BLIND.find(([re]) => re.test(key.replace(/^(\w+) /, '$1 ')))?.[1];

async function liveReserved(role: 'partner' | 'support'): Promise<{ next: () => Promise<string> }> {
  const id = uuidv7(realClock.now());
  await migrator.query(
    `insert into "user" (id, name, email, "emailVerified", role, locale, status, "twoFactorEnabled", "provisionedAt")
     values ($1, $2, $3, true, $4, 'fr', 'active', true, now())`,
    [id, `Reserved ${role} live`, `e2e-reserved-live-${id}@kayas.test`, role],
  );
  return {
    next: async () => {
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8);
      await migrator.query(
        `insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "twoFactorAt") values ($1, now() + interval '1 hour', $2, now(), now(), $3, now())`,
        [randomUUID(), token, id],
      );
      const { signedCookie } = await import('./sweep-support');
      return signedCookie(token, SECRET);
    },
  };
}

for (const role of ['partner', 'support'] as const) {
  test(`${role}: every route (PDF and export routes included) and every server action is refused for a LIVE session, for every method; 405 only where the method is not exported`, async () => {
    test.setTimeout(900_000);
    const reserved = await liveReserved(role);
    const admin = await identity(`control-${role}`, 'app_admin');
    const { routes } = routeInventory();
    const actions = serverActions();
    const leaks: string[] = [];
    const unexpected405: string[] = [];
    const blind: string[] = [];
    const targets: {
      key: string;
      method: Method;
      url: string;
      headers: Record<string, string>;
      exported: boolean;
    }[] = [];
    for (const r of routes)
      for (const m of ['GET', ...WRITE_METHODS] as Method[])
        targets.push({
          key: `${m} ${r.url}`,
          method: m,
          url: r.url,
          headers: {},
          exported: r.methods.includes(m),
        });
    for (const a of actions)
      targets.push({
        key: `ACTION ${a.id.slice(0, 10)} ${a.url}`,
        method: 'POST',
        url: a.url,
        headers: { 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8' },
        exported: true,
      });
    const writes0 = await businessWrites(migrator);
    for (const t of targets) {
      const probe = await send(await reserved.next(), t.method, t.url, t.headers);
      const isAction = t.key.startsWith('ACTION');
      if (t.exported) {
        if (!(isAction ? actionRefused(probe) : denied(probe))) leaks.push(`${t.key} -> ${probe.status}`);
      } else if (!denied(probe) && probe.status !== 405)
        leaks.push(`${t.key} (not exported) -> ${probe.status}`);
      else if (probe.status === 405 && t.exported) unexpected405.push(t.key);
      if (t.exported && !isAction) {
        // the positive control of THIS target: a valid admin session reaches the handler (anything but a denial or "no such method")
        const control = await send(await cloneForAdmin(admin.id), t.method, t.url, t.headers);
        if (!reached(control) && !blindReason(t.key)) blind.push(`${t.key} -> admin ${control.status}`);
      }
    }
    // an action refuses by doing nothing: the reserved sweep wrote nothing at all (no business row in the audit log)
    expect(await businessWrites(migrator), 'the sweep wrote nothing').toBe(writes0);
    expect(leaks).toEqual([]);
    expect(unexpected405).toEqual([]);
    // targets the control could not reach are listed with a reason, or the sweep says nothing about them
    expect(blind, 'targets neither reached by the control nor listed in BLIND').toEqual([]);
    expect(targets.filter((t) => t.exported).length).toBeGreaterThan(40);
  });
}

async function cloneForAdmin(userId: string): Promise<string> {
  return cloneSession(migrator, userId, SECRET);
}

test('partner: the password-login counterpart — a reserved partner account cannot sign in either, and no session row or cookie results', async () => {
  const email = `e2e-reserved-login-partner-${randomUUID().slice(0, 8)}@kayas.test`;
  const auth = createAuth({ authPool, env: { ...env, APP_BASE_URL: E2E_BASE_URL } });
  const made = await createUser(auth, authPool, {
    actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
    email,
    name: 'Reserved login partner',
    password: PASSWORD,
    role: 'app_admin',
    locale: 'fr',
  });
  // control: while it is an ordinary account the very same request signs in
  const ok = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  const first = await ok.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
    headers: { origin: E2E_BASE_URL },
  });
  expect(first.status()).toBe(200);
  await migrator.query(`delete from "session" where "userId" = $1`, [made.id]);
  await migrator.query(`update "user" set role = 'partner' where id = $1`, [made.id]);
  const res = await ok.post('/api/auth/sign-in/email', {
    data: { email, password: PASSWORD },
    headers: { origin: E2E_BASE_URL },
  });
  expect((res.headers()['set-cookie'] ?? '').includes('session_token')).toBe(false);
  expect((await migrator.query('select 1 from "session" where "userId" = $1', [made.id])).rowCount).toBe(0);
  await ok.dispose();
});
