import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '@/lib/db/rls-context';
import { testEnv } from '../../../../tests/db-env';
import { recordAuditEvent } from './audit-service';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(async () => {
  await app.end();
  await migrator.end();
});

const ownerId = '0190c2a8-0000-7000-8000-000000000001';

describe('recordAuditEvent', () => {
  it('stores a service-level event and returns its id', async () => {
    const requestId = `svc-${randomUUID()}`;
    const id = await withRlsContext(app, { userId: ownerId, role: 'owner', requestId }, (tx) =>
      recordAuditEvent(tx, { action: 'permission_denied', table: 'app_user', reason: 'admin/users' }),
    );
    const { rows } = await migrator.query(
      'select id, action, reason, actor_user_id from audit_event where request_id = $1',
      [requestId],
    );
    expect(rows).toEqual([
      { id: String(id), action: 'permission_denied', reason: 'admin/users', actor_user_id: ownerId },
    ]);
  });

  it('rejects data-change actions before reaching the database', async () => {
    await expect(
      withRlsContext(app, { userId: ownerId, role: 'owner', requestId: `svc-${randomUUID()}` }, (tx) =>
        recordAuditEvent(tx, { action: 'insert' as never, table: 'app_user' }),
      ),
    ).rejects.toThrow(/action/);
  });
});
