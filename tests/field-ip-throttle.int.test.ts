import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleFieldLogin } from '../src/app/api/field/login/handler';
import { keyedHash } from '../src/lib/crypto/hmac';
import { withRlsContext } from '../src/lib/db/rls-context';
import { realClock } from '../src/modules/clock';
import { createFieldAccount, setDriverPin } from '../src/modules/field';
import { readParameters, releaseFieldAttempt, reserveFieldAttempt } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { authTestKit } from './auth-helpers';
import { realSessionUser } from './helpers/actors';

// R11-01 / R12-03: the phone sign-in has a per-IP limit that is an atomic reservation made before the expensive work, counts every
// attempt that does not end in a sign-in (the one that locks a driver included), shares one bucket for an unknown IP, and bounds the
// verifications in flight. Proved here with real HTTP requests fired in parallel at the handler.
const kit = authTestKit();
const app = new pg.Pool({ connectionString: kit.env.DATABASE_URL_APP, max: 4 });
const guard = () => ({
  pool: kit.authPool,
  hmacKey: kit.env.LOOKUP_HMAC_KEY,
  clock: realClock,
  parameters: () => readParameters(kit.authPool),
});
const used = async (ip: string | null) =>
  Number(
    (
      await kit.authPool.query<{ n: string }>(
        `select count(*)::text as n from login_attempt r
          where r.ip_hmac = $1 and not r.success
            and not exists (select 1 from login_attempt s where s.identifier_hmac = r.identifier_hmac and s.ip_hmac = r.ip_hmac and s.success)`,
        [keyedHash(kit.env.LOOKUP_HMAC_KEY, `fieldip:${ip ?? 'unknown'}`)],
      )
    ).rows[0]?.n ?? 0,
  );
const randomIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

let server: Server;
let base = '';
let maxInFlight = 8;
let owner: SessionUser;
const deps = () => ({ appPool: app, authPool: kit.authPool, auth: kit.auth, secret: kit.env.AUTH_SECRET });

beforeAll(async () => {
  owner = await realSessionUser(kit.env.DATABASE_URL_MIGRATOR, 'owner');
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://localhost${req.url}`, {
      method: 'POST',
      headers,
      body: Buffer.concat(chunks),
    });
    const response = await handleFieldLogin(request, {
      deps: deps(),
      guard: guard(),
      trustedHops: 1,
      now: new Date(),
      maxInFlight,
      setCookie: async () => undefined,
    });
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(await response.text());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await app.end();
  await kit.close();
});

const post = async (ip: string | null, body: object) => {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': `203.0.113.250, ${ip}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as { error?: string } };
};
const wrong = () => ({
  code: `CH-${9000 + Math.floor(Math.random() * 900)}`,
  pin: '123456',
  deviceId: randomUUID(),
});

describe('reservation helpers', () => {
  it('reserve up to the limit, then refuse; a released attempt is given back; another IP is untouched', async () => {
    const limit = (await guard().parameters())['auth.lockout_ip_failures'];
    const ip = randomIp();
    const held = [];
    for (let i = 0; i < limit; i++) held.push(await reserveFieldAttempt(guard(), ip));
    expect(held.every((r) => r && r.id)).toBe(true);
    expect(new Set(held.map((r) => r!.id)).size).toBe(limit); // each reservation has its own id
    expect(await reserveFieldAttempt(guard(), ip)).toBeNull();
    await releaseFieldAttempt(guard(), ip, held[0]!);
    expect(await reserveFieldAttempt(guard(), ip)).not.toBeNull();
    expect(await reserveFieldAttempt(guard(), ip)).toBeNull();
    expect(await reserveFieldAttempt(guard(), randomIp())).not.toBeNull();
  });
  it('R13-02: a release frees only its own reservation, once, and the reservation keeps its original time', async () => {
    const limit = (await guard().parameters())['auth.lockout_ip_failures'];
    const ip = randomIp();
    const held = [];
    for (let i = 0; i < limit; i++) held.push((await reserveFieldAttempt(guard(), ip))!);
    const at = async (id: string) =>
      (
        await kit.authPool.query<{ at: Date }>(
          'select at from login_attempt where not success and identifier_hmac = $1',
          [keyedHash(kit.env.LOOKUP_HMAC_KEY, `fieldres:${id}`)],
        )
      ).rows[0]!.at.getTime();
    const before = await at(held[0]!.id);
    await releaseFieldAttempt(guard(), ip, held[0]!);
    await releaseFieldAttempt(guard(), ip, held[0]!); // twice: still one reservation freed
    expect(await at(held[0]!.id)).toBe(before);
    expect(await used(ip)).toBe(limit - 1);
    expect(await reserveFieldAttempt(guard(), ip)).not.toBeNull();
    expect(await reserveFieldAttempt(guard(), ip)).toBeNull();
  });
  it('R13-02: a success that completes after the window has moved cannot offset a later wrong attempt', async () => {
    const params = await guard().parameters();
    const limit = params['auth.lockout_ip_failures'];
    const windowMs = params['auth.lockout_window_minutes'] * 60_000;
    const ip = randomIp();
    const t0 = Date.now() - 2 * windowMs - 60_000; // far enough back that the whole story is in the past
    const at = (ms: number) => ({ ...guard(), clock: { ...realClock, now: () => new Date(t0 + ms) } });
    const held = [];
    for (let i = 0; i < limit; i++) held.push((await reserveFieldAttempt(at(i), ip))!);
    expect(await reserveFieldAttempt(at(limit), ip)).toBeNull();
    // the window moves on: the old reservations aged out; only now does the slow request of the first one finish, with a success
    const later = windowMs + 60_000;
    await releaseFieldAttempt(at(later), ip, held[0]!);
    // a burst of wrong attempts right after: exactly the nominal budget, the late success credits none of them
    let granted = 0;
    for (let i = 0; i < limit + 3; i++) if (await reserveFieldAttempt(at(later + 1000 + i), ip)) granted++;
    expect(granted).toBe(limit);
  });
  it('an unknown or malformed IP is one shared bucket that also fills up (never "not locked")', async () => {
    const limit = (await guard().parameters())['auth.lockout_ip_failures'];
    const before = await used(null);
    let granted = 0;
    for (let i = 0; i < limit + 5; i++) if (await reserveFieldAttempt(guard(), null)) granted++;
    expect(granted).toBeLessThanOrEqual(limit);
    expect(await used(null)).toBeGreaterThanOrEqual(Math.min(limit, before + granted));
  });
  it('parallel reservations never overshoot the limit', async () => {
    const limit = (await guard().parameters())['auth.lockout_ip_failures'];
    const ip = randomIp();
    const grants = await Promise.all(
      Array.from({ length: limit * 3 }, () => reserveFieldAttempt(guard(), ip)),
    );
    expect(grants.filter(Boolean)).toHaveLength(limit);
    expect(new Set(grants.filter(Boolean).map((g) => g!.id)).size).toBe(limit);
    expect(await used(ip)).toBe(limit);
  });
});

describe('real HTTP requests in parallel', () => {
  it('a burst of wrong attempts from one IP never gets more verified attempts than the configured limit', async () => {
    const limit = (await guard().parameters())['auth.lockout_ip_failures'];
    const ip = randomIp();
    maxInFlight = 1000; // let the reservation, not the in-flight bound, be what stops the burst
    const burst = await Promise.all(Array.from({ length: limit * 4 }, () => post(ip, wrong())));
    const verified = burst.filter((r) => r.status === 401);
    const refused = burst.filter((r) => r.status === 429);
    expect(verified).toHaveLength(limit);
    expect(refused).toHaveLength(limit * 3);
    expect(await used(ip)).toBe(limit);
    // and it stays closed for that IP, while another IP can still try
    expect((await post(ip, wrong())).status).toBe(429);
    expect((await post(randomIp(), wrong())).status).toBe(401);
  }, 60_000);

  it('the in-flight bound answers BUSY without reserving anything', async () => {
    const ip = randomIp();
    maxInFlight = 2;
    const burst = await Promise.all(Array.from({ length: 12 }, () => post(ip, wrong())));
    const busy = burst.filter((r) => r.status === 503);
    const done = burst.filter((r) => r.status === 401);
    expect(busy.length).toBeGreaterThan(0);
    expect(done.length + busy.length).toBe(12);
    expect(await used(ip)).toBe(done.length); // a BUSY answer reserved nothing
    maxInFlight = 8;
  }, 60_000);

  it('requests without a trusted client address share the "unknown" bucket and get limited', async () => {
    const limit = (await guard().parameters())['auth.lockout_ip_failures'];
    maxInFlight = 1000;
    const burst = await Promise.all(Array.from({ length: limit * 3 }, () => post(null, wrong())));
    expect(burst.some((r) => r.status === 429)).toBe(true);
    expect(burst.filter((r) => r.status === 401).length).toBeLessThanOrEqual(limit);
    maxInFlight = 8;
  }, 60_000);

  it('the fifth wrong PIN that locks a driver still counts against the IP, and a correct sign-in is given back', async () => {
    const no = 700 + Math.floor(Math.random() * 250);
    const d = (
      await withRlsContext(app, { userId: owner.id, role: 'owner', requestId: randomUUID() }, (tx) =>
        tx.query<{ id: string; code: string }>(
          `insert into driver (id, code, name, created_by, kind) values (gen_random_uuid(), $1, $2, $3, 'driver') returning id, code`,
          [`CH-${no}`, `ip throttle ${no}`, owner.id],
        ),
      )
    ).rows[0]!;
    expect((await createFieldAccount(deps(), owner, d.id)).ok).toBe(true);
    expect((await setDriverPin(deps(), owner, { driverId: d.id, pin: '482913' })).ok).toBe(true);
    const ip = randomIp();
    const device = randomUUID();
    const answers: number[] = [];
    for (let i = 0; i < 5; i++)
      answers.push((await post(ip, { code: d.code, pin: '000000', deviceId: device })).status);
    expect(answers).toEqual([401, 401, 401, 401, 403]); // the fifth locks the driver
    expect(await used(ip)).toBe(5); // all five counted, the locking one included
    const other = randomIp();
    const fine = await post(other, { code: d.code, pin: '482913', deviceId: device });
    expect(fine.status).toBe(403); // locked: a correct PIN after the lock does not clear it
    expect(await used(other)).toBe(1);
  }, 60_000);
});
