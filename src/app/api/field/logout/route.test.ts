import { beforeEach, describe, expect, it, vi } from 'vitest';

// R15A-01: the server side of the logout is idempotent. A logout that carries no phone cookie sets no header at all, so a repeated
// or late logout cannot clear a cookie that a newer sign-in set.
const jar = { value: undefined as string | undefined, deleted: 0 };
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
  fieldRoute: async (_r: Request, _o: unknown, run: () => Promise<Response>) => run(),
}));
vi.mock('@/modules/field', () => ({ FIELD_COOKIE: 'bb_field' }));

import { POST } from './route';

beforeEach(() => {
  jar.value = undefined;
  jar.deleted = 0;
});

describe('POST /api/field/logout', () => {
  it('ends the session it carries', async () => {
    jar.value = 'token-a';
    const res = await POST(new Request('http://x/api/field/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(jar.deleted).toBe(1);
  });

  it('is idempotent: with no phone cookie it answers 200 and clears nothing', async () => {
    const res = await POST(new Request('http://x/api/field/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(jar.deleted).toBe(0);
  });
});
