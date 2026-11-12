import { type APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { parseAuthSecrets } from '../src/lib/env';
import { E2E_BASE_URL } from './fixtures';

// R19 group 3A/3B: what the HTTP sweeps share. The route inventory comes from the SOURCE TREE and the build (so a new route or server action is swept without
// anyone remembering it); a cookie is signed the way the server signs it, so a test can hold MANY live sessions of one account and probe every target with a
// session that has not been revoked by an earlier probe.
export const UUID = '0194a8a0-0000-7000-8000-000000000001';
export const SESSION_COOKIE = '__Host-bb.session_token';
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = 'GET' | (typeof WRITE_METHODS)[number];

export interface RouteRef {
  url: string;
  file: string;
  methods: Method[];
  /** The `@permission` line of the file, for the report. */
  permission: string;
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const toUrl = (rel: string): string =>
  rel
    .split('/')
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) =>
      seg === '[locale]' ? 'fr' : /^\[\[?\.\.\./.test(seg) ? 'x' : /^\[.*\]$/.test(seg) ? UUID : seg,
    )
    .join('/');
const methodsOf = (src: string): Method[] => {
  const found = new Set<Method>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g))
    found.add(m[1] as Method);
  return [...found];
};

/** Every `route.ts` (the protected PDF and export routes included) with the methods it exports; Better Auth's own and the public probes are left out. */
export function routeInventory(): { pages: string[]; routes: RouteRef[] } {
  const pages = walk('src/app/[locale]/(protected)')
    .filter((f) => /\/page\.tsx$/.test(f))
    .map((f) => `/${toUrl(f.replace('src/app/', '').replace(/\/page\.tsx$/, ''))}`);
  const routes = walk('src/app')
    .filter((f) => /\/route\.ts$/.test(f))
    .filter((f) => !/\/api\/auth\//.test(f))
    .map((f): RouteRef => {
      const src = readFileSync(f, 'utf8');
      return {
        url: `/${toUrl(f.replace('src/app/', '').replace(/\/route\.ts$/, ''))}`,
        file: f,
        methods: methodsOf(src),
        permission: /@permission\s+([^\n*]*)/.exec(src)?.[1]?.trim() ?? '',
      };
    })
    .filter((r) => !/^(public|none)\b/.test(r.permission));
  return { pages: [...new Set(pages)].sort(), routes: routes.sort((a, b) => (a.url < b.url ? -1 : 1)) };
}

/** The server actions of the build: the id Next knows each by, and the page that hosts it (a POST with `Next-Action: <id>` to that page runs it). */
export function serverActions(): { id: string; url: string }[] {
  const dist = ['.next-e2e', '.next'].find((d) =>
    existsSync(join(d, 'server/server-reference-manifest.json')),
  );
  if (!dist) return [];
  const manifest = JSON.parse(readFileSync(join(dist, 'server/server-reference-manifest.json'), 'utf8')) as {
    node?: Record<string, { workers: Record<string, unknown> }>;
  };
  const out: { id: string; url: string }[] = [];
  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    const page = Object.keys(entry.workers).find((w) => /^app\/\[locale\]\/\(protected\)\/.*\/page$/.test(w));
    if (!page) continue;
    out.push({ id, url: `/${toUrl(page.replace(/^app\//, '').replace(/\/page$/, ''))}` });
  }
  return out.sort((a, b) => (a.url + a.id < b.url + b.id ? -1 : 1));
}

/** The secret the server signs the session cookie with: the current (highest) version of the keyring, or AUTH_SECRET when there is none. */
export function sessionSecret(env: { AUTH_SECRET: string; AUTH_SECRETS?: string | undefined }): string {
  return parseAuthSecrets(env).sort((a, b) => b.version - a.version)[0]!.value;
}

/** The cookie header value for a session token, signed like the server signs it (HMAC-SHA256 of the token with AUTH_SECRET, base64, URL-encoded). */
export function signedCookie(token: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(token).digest('base64');
  return `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${sig}`)}`;
}

/**
 * Another LIVE session of the same account (copied from one the account already has), signed. Each probe of a sweep can use its own, so a probe is judged by
 * the gate of a session that no earlier probe has revoked.
 */
export async function cloneSession(migrator: pg.Pool, userId: string, secret: string): Promise<string> {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8);
  await migrator.query(
    `insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "twoFactorAt")
     select $2, now() + interval '1 hour', $3, now(), now(), "ipAddress", "userAgent", "userId", now()
       from "session" where "userId" = $1 order by "createdAt" limit 1`,
    [userId, randomUUID(), token],
  );
  return signedCookie(token, secret);
}

const contexts = new Map<string, Promise<APIRequestContext>>();
/** A request context that sends THIS cookie header (the context's own jar would drop a __Host- cookie on plain http). */
export function as(cookie: string): Promise<APIRequestContext> {
  if (!contexts.has(cookie))
    contexts.set(
      cookie,
      playwrightRequest.newContext({
        baseURL: E2E_BASE_URL,
        extraHTTPHeaders: { cookie, origin: E2E_BASE_URL },
      }),
    );
  return contexts.get(cookie)!;
}

export interface Probe {
  status: number;
  /** `Location`, or for a server action the redirect it asks the client to follow (`x-action-redirect`). */
  location: string;
  body: string;
}
export async function send(
  cookie: string,
  method: Method,
  url: string,
  headers: Record<string, string> = {},
): Promise<Probe> {
  const ctx = await as(cookie);
  const res = await ctx.fetch(url, {
    method,
    maxRedirects: 0,
    headers,
    data: method === 'GET' ? undefined : method === 'DELETE' ? undefined : '{}',
    failOnStatusCode: false,
  });
  const h = res.headers();
  const body = (await res.text().catch(() => '')).slice(0, 400);
  return { status: res.status(), location: h['location'] ?? h['x-action-redirect'] ?? '', body };
}

/** Denied: unauthenticated, forbidden, not found (a module off or a hidden target), or a redirect to the sign-in. */
export const denied = (p: Probe): boolean =>
  p.status === 401 ||
  p.status === 403 ||
  p.status === 404 ||
  (p.status >= 300 && p.status < 400 && /login|sign-?in|\/fr\/?$/.test(p.location));
/** The request reached a handler: neither a denial nor "no such method". */
export const reached = (p: Probe): boolean => !denied(p) && p.status !== 405;

/** An ordinary account with a REAL session, created like the other e2e users and signed in over HTTP; its role is then set by the privileged path. */
export function identityFactory(deps: {
  env: { APP_BASE_URL?: string } & Record<string, unknown>;
  migrator: pg.Pool;
  authPool: pg.Pool;
  createAuth: (o: never) => unknown;
  createUser: (auth: never, pool: never, input: never) => Promise<{ id: string }>;
  bootstrapActor: { userId: string; role: 'system' };
  password: string;
}) {
  return async function identity(
    label: string,
    role: string,
  ): Promise<{ id: string; cookie: string; email: string }> {
    const email = `e2e-neg-${label}-${randomUUID().slice(0, 8)}@kayas.test`;
    const auth = deps.createAuth({
      authPool: deps.authPool,
      env: { ...deps.env, APP_BASE_URL: E2E_BASE_URL },
    } as never);
    const made = await deps.createUser(
      auth as never,
      deps.authPool as never,
      {
        actor: deps.bootstrapActor,
        email,
        name: `Neg ${label}`,
        password: deps.password,
        role: 'app_admin',
        locale: 'fr',
      } as never,
    );
    const login = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
    const res = await login.post('/api/auth/sign-in/email', {
      data: { email, password: deps.password },
      headers: { origin: E2E_BASE_URL },
    });
    if (res.status() !== 200) throw new Error(`sign-in failed (${res.status()})`);
    const cookie = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value.split(';')[0]!)
      .join('; ');
    await login.dispose();
    await deps.migrator.query(`update "user" set "twoFactorEnabled" = true where id = $1`, [made.id]);
    await deps.migrator.query(`update "session" set "twoFactorAt" = now() where "userId" = $1`, [made.id]);
    if (role !== 'app_admin')
      await deps.migrator.query(`update "user" set role = $2 where id = $1`, [made.id, role]);
    return { id: made.id, cookie, email };
  };
}

/**
 * A server action refuses a caller by doing NOTHING (it authorizes inside, and a caller without the permission gets `undefined`, `{ ok: false, ... }` or a redirect
 * to the sign-in back), so a 200 whose result is not `ok: true` is its refusal. The sweep therefore checks two things: the answer is a refusal or an empty result, and the database saw no
 * business write while the sweep ran (see `businessWrites`).
 */
export const actionRefused = (p: Probe): boolean =>
  denied(p) || (p.status >= 300 && p.status < 400) || (p.status === 200 && !/"ok":true/.test(p.body));

/** The number of business writes in the audit log (not logins, step-ups or denials, and not a person's own notifications or push subscription): equal before and after a sweep means the sweep wrote nothing. */
export async function businessWrites(migrator: pg.Pool): Promise<number> {
  return Number(
    (
      await migrator.query<{ n: string }>(
        `select count(*)::text n from audit_event where action in ('insert','update','reverse','archive','import','export','user_created','user_disabled','user_enabled') and table_name not in ('notification','push_subscription')`,
      )
    ).rows[0]!.n,
  );
}
