import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/pools', () => ({ getPool: () => ({ query: async () => ({ rows: [{ n: 99999 }] }) }) }));
vi.mock('@/lib/server-env', () => ({ getEnv: () => ({ TRAINING_MODE: false }) }));

import { GET } from './route';

const g = globalThis as { __kayasAdmission?: string };
afterEach(() => {
  delete g.__kayasAdmission;
});

describe('R18-03: the server is not ready until the reserved-account admission has passed', () => {
  it('pending or failed admission: 503 not_ready, whatever the database says', async () => {
    for (const state of ['pending', 'failed']) {
      g.__kayasAdmission = state;
      const res = await GET();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready' });
    }
  });
  it('done (or no admission tracked, as in a unit test): ready', async () => {
    g.__kayasAdmission = 'done';
    expect((await GET()).status).toBe(200);
    delete g.__kayasAdmission;
    expect((await GET()).status).toBe(200);
  });
});
