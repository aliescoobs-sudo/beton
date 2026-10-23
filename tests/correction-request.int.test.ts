import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { listCorrectionRequests, requestCorrection } from '../src/modules/ledger';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L5b (DECISIONS 81): office files a correction request instead of reversing what it cannot read.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const tag = () => `Test ${Math.random().toString(36).slice(2, 9)}`;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

describe('requestCorrection', () => {
  it('office files a request and gets back only an id; the owner and support read it', async () => {
    const reason = tag();
    const made = await requestCorrection(app, users.office, { documentCode: 'cmd-2026-00042', reason });
    if (!made.ok) throw new Error(made.error);
    expect(Object.keys(made.value)).toEqual(['id']);
    for (const role of ['owner', 'support'] as const) {
      const list = await listCorrectionRequests(app, users[role]);
      expect(list.find((r) => r.id === made.value.id)).toMatchObject({
        documentCode: 'CMD-2026-00042',
        reason,
        requestedBy: users.office.id,
      });
    }
  });

  it('an unknown document code is accepted like a real one: the request reveals nothing', async () => {
    expect(
      await requestCorrection(app, users.office, { documentCode: 'FA-2099-99999', reason: tag() }),
    ).toMatchObject({ ok: true });
  });

  it('office cannot read the queue back, by service or SQL; partner and plant neither', async () => {
    await requestCorrection(app, users.office, { documentCode: 'ACH-2026-00001', reason: tag() });
    for (const role of ['office', 'partner', 'plant'] as const) {
      await expect(listCorrectionRequests(app, users[role]), role).rejects.toThrow('Forbidden');
      const { rows } = await inCtx(users[role], (tx) => tx.query('select 1 from correction_request'));
      expect(rows, role).toEqual([]);
    }
  });

  it('partner, plant and support cannot file one (service and RLS); an invalid request is refused', async () => {
    for (const role of ['partner', 'plant', 'support'] as const) {
      await expect(
        requestCorrection(app, users[role], { documentCode: 'CMD-2026-00001', reason: 'raison' }),
        role,
      ).rejects.toThrow('Forbidden');
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into correction_request (id, document_code, reason, requested_by)
             values (gen_random_uuid(), 'CMD-2026-00001', 'raison', $1)`,
            [users[role].id],
          ),
        ),
        role,
      ).rejects.toMatchObject({ code: '42501' });
    }
    expect(await requestCorrection(app, users.office, { documentCode: 'nope', reason: 'raison' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('is insert-only and every request is audited', async () => {
    const reason = tag();
    const made = await requestCorrection(app, users.office, { documentCode: 'CMD-2026-00007', reason });
    if (!made.ok) throw new Error(made.error);
    for (const sql of ['update correction_request set reason = reason', 'delete from correction_request']) {
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    const { rows } = await inCtx(users.owner, (tx) =>
      tx.query(`select 1 from audit_event where table_name = 'correction_request' and row_id = $1`, [
        made.value.id,
      ]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
