import { beforeEach, describe, expect, it, vi } from 'vitest';

// R15A-01 / T10c: the server side of the logout is idempotent, and it ENDS the session on the server before the cookie is dropped. A logout that
// carries no phone cookie does nothing at all, so a repeated or late logout cannot clear a cookie that a newer sign-in set.
const jar = { value: undefined as string | undefined, deleted: 0 };
const closed: unknown[] = [];
let closeFails = false;
let closeResult: boolean | 'cas' = true;
const server = { gen: 4 }; // the phone's generation on the server (R18-05: the compare-and-set)
let verified: unknown = {
  driverId: 'd',
  deviceHash: 'h',
  deviceRowId: '0194a8a0-0000-7000-8000-0000000000aa',
  gen: 4,
  exp: 9e9,
};
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'bb_field' && jar.value ? { name, value: jar.value } : undefined),
    delete: (name: string) => {
      if (name === 'bb_field') jar.deleted++;
    },
  }),
}));
vi.mock('../context', () => ({
  fieldJson: (status: number, body: unknown) => Response.json(body, { status }),
  fieldRoute: async (_r: Request, _o: unknown, run: (c: unknown) => Promise<Response>) => run({ deps: {} }),
}));
vi.mock('@/app/request-clock', () => ({ getRequestClock: async () => ({ now: () => new Date(1_000_000) }) }));
vi.mock('@/lib/server-env', () => ({ getEnv: () => ({ AUTH_SECRET: 's'.repeat(40) }) }));
vi.mock('@/modules/field', () => ({
  FIELD_COOKIE: 'bb_field',
  verifyFieldToken: () => verified,
  closeFieldSession: async (_d: unknown, token: unknown) => {
    if (closeFails) throw new Error('db down');
    closed.push(token);
    if (closeResult === 'cas') {
      const live = (token as { gen: number }).gen === server.gen;
      if (live) server.gen += 1;
      return live;
    }
    return closeResult;
  },
}));

import { POST } from './route';

beforeEach(() => {
  jar.value = undefined;
  jar.deleted = 0;
  closed.length = 0;
  closeFails = false;
  closeResult = true;
  server.gen = 4;
  verified = {
    driverId: 'd',
    deviceHash: 'h',
    deviceRowId: '0194a8a0-0000-7000-8000-0000000000aa',
    gen: 4,
    exp: 9e9,
  };
});
const post = () => POST(new Request('http://x/api/field/logout', { method: 'POST' }));

describe('POST /api/field/logout', () => {
  it('ends the session on the server, then drops the cookie', async () => {
    jar.value = 'token-a';
    const res = await post();
    expect(res.status).toBe(200);
    expect(closed).toEqual([
      {
        driverId: 'd',
        deviceHash: 'h',
        deviceRowId: '0194a8a0-0000-7000-8000-0000000000aa',
        gen: 4,
        exp: 9e9,
      },
    ]);
    expect(jar.deleted).toBe(1);
  });

  it('a server that cannot record the logout answers 503 and KEEPS the cookie, so the phone retries', async () => {
    jar.value = 'token-a';
    closeFails = true;
    const res = await post();
    expect(res.status).toBe(503);
    expect(jar.deleted).toBe(0);
  });

  it('an expired or forged cookie has nothing to end on the server; the cookie is dropped', async () => {
    jar.value = 'forged';
    verified = null;
    const res = await post();
    expect(res.status).toBe(200);
    expect(closed).toEqual([]);
    expect(jar.deleted).toBe(1);
  });

  it('R18-05: a logout whose compare-and-set found the session already superseded (a newer sign-in of the phone) does NOT delete the shared cookie', async () => {
    jar.value = 'the-cookie-this-request-carried';
    closeResult = false; // the generation moved: another tab signed in; the browser's cookie may be the NEWER one
    const res = await post();
    expect(res.status).toBe(200);
    expect(closed).toHaveLength(1); // the server was asked
    expect(jar.deleted).toBe(0); // and no Set-Cookie that would sign the newer tab out
  });

  it("R18-05: tab A's logout (token of generation 4) reaches the server AFTER tab B signed in (generation 5): B's fresh cookie survives, and a second logout of B's own token still works", async () => {
    closeResult = 'cas';
    server.gen = 5; // tab B's sign-in moved the generation before A's delayed logout was processed
    jar.value = 'tab-a-old-cookie';
    expect((await post()).status).toBe(200);
    expect(jar.deleted).toBe(0);
    expect(server.gen).toBe(5); // and B's session was not touched
    // B's own logout (its token carries generation 5) ends it and drops the cookie
    verified = {
      driverId: 'd',
      deviceHash: 'h',
      deviceRowId: '0194a8a0-0000-7000-8000-0000000000aa',
      gen: 5,
      exp: 9e9,
    };
    jar.value = 'tab-b-cookie';
    expect((await post()).status).toBe(200);
    expect(jar.deleted).toBe(1);
    expect(server.gen).toBe(6);
  });

  it('is idempotent: with no phone cookie it answers 200, ends nothing and clears nothing', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(closed).toEqual([]);
    expect(jar.deleted).toBe(0);
  });
});
