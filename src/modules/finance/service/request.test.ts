import type pg from 'pg';
import { describe, it, expect, vi } from 'vitest';
import { realClock } from '@/modules/clock';
import { financeRequest } from './request';
const actor = {
  id: '01900000-0000-7000-8000-000000000010',
  role: 'owner',
  name: 'Owner',
  email: 'fake@example.test',
  locale: 'fr' as const,
  twoFactorEnabled: true,
  reenrolRequired: false,
};
function pool(enabled = true) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => ({
      rows: sql.includes('finance.enabled')
        ? [{ enabled }]
        : sql.includes('audit.record')
          ? [{ id: '1' }]
          : [],
    })),
    release = vi.fn();
  return { query, release, connect: vi.fn(async () => ({ query, release })) };
}
describe('finance service guards with no database', () => {
  it('denies money reads to accountant/support before acquiring a connection', async () => {
    for (const role of ['accountant', 'support', 'office']) {
      const p = pool();
      await expect(
        financeRequest(p as unknown as pg.Pool, { ...actor, role }, 'finance.read', async () => 1),
      ).rejects.toThrow('FINANCE_UNAVAILABLE');
      expect(p.connect).not.toHaveBeenCalled();
    }
  });
  it('requires recent real TOTP, refuses recovery login and mismatched session actor', async () => {
    const p = pool();
    for (const session of [
      { user: actor, twoFactorAt: null },
      { user: actor, twoFactorAt: new Date('2000-01-01') },
      { user: { ...actor, id: 'different' }, twoFactorAt: realClock.now() },
    ])
      await expect(
        financeRequest(p as unknown as pg.Pool, actor, 'finance.write', async () => 1, { session }),
      ).rejects.toThrow('STEP_UP_REQUIRED');
    expect(p.connect).not.toHaveBeenCalled();
  });
  it('rolls back on flag-off and on any write failure; releases pooled connection', async () => {
    const p = pool(false);
    const f = vi.fn(async () => 1);
    await expect(financeRequest(p as unknown as pg.Pool, actor, 'finance.read', f)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
    expect(p.query).toHaveBeenCalledWith('ROLLBACK');
    expect(p.release).toHaveBeenCalled();
    const q = pool();
    await expect(
      financeRequest(q as unknown as pg.Pool, actor, 'finance.read', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(q.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('uses a stricter configured TOTP duration before running any money write', async () => {
    const p = pool(),
      original = p.query.getMockImplementation()!;
    p.query.mockImplementation(async (sql) =>
      sql.includes('finance.step_up_minutes') ? { rows: [{ minutes: 1 }] } : original(sql),
    );
    const work = vi.fn(async () => 1);
    await expect(
      financeRequest(p as unknown as pg.Pool, actor, 'finance.write', work, {
        session: { user: actor, twoFactorAt: new Date(realClock.now().getTime() - 120000) },
      }),
    ).rejects.toThrow('STEP_UP_REQUIRED');
    expect(work).not.toHaveBeenCalled();
    expect(p.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('audits exports and uses READ COMMITTED for the existing hash-chain writer', async () => {
    const p = pool();
    await expect(
      financeRequest(
        p as unknown as pg.Pool,
        { ...actor, role: 'accountant' },
        'finance.export',
        async () => 9,
      ),
    ).resolves.toBe(9);
    expect(p.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(p.query.mock.calls.find((c) => c[0].includes('audit.record'))).toBeDefined();
    expect(p.query).toHaveBeenCalledWith('COMMIT');
  });
});
