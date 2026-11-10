import { beforeEach, describe, expect, it, vi } from 'vitest';

// R15A-01 / T10c: the server side of the logout is idempotent, and it ENDS the session on the server before the cookie is dropped. A logout that
// carries no phone cookie does nothing at all, so a repeated or late logout cannot clear a cookie that a newer sign-in set.
const jar = { value: undefined as string | undefined, deleted: 0 };
const closed: unknown[] = [];
let closeFails = false;
let verified: unknown = { driverId: 'd', deviceHash: 'h', gen: 4, exp: 9e9 };
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
    return true;
  },
}));

import { POST } from './route';

beforeEach(() => {
  jar.value = undefined;
  jar.deleted = 0;
  closed.length = 0;
  closeFails = false;
  verified = { driverId: 'd', deviceHash: 'h', gen: 4, exp: 9e9 };
});
const post = () => POST(new Request('http://x/api/field/logout', { method: 'POST' }));

describe('POST /api/field/logout', () => {
  it('ends the session on the server, then drops the cookie', async () => {
    jar.value = 'token-a';
    const res = await post();
    expect(res.status).toBe(200);
    expect(closed).toEqual([{ driverId: 'd', deviceHash: 'h', gen: 4, exp: 9e9 }]);
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

  it('is idempotent: with no phone cookie it answers 200, ends nothing and clears nothing', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(closed).toEqual([]);
    expect(jar.deleted).toBe(0);
  });
});
