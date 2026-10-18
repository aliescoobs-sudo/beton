import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { listAuditEvents } from '../src/modules/platform-security/service/audit-query';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

let owner: SessionUser;
let office: SessionUser;
let plant: SessionUser;
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
  plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
});
const tag = `viewer-${randomUUID()}`;

beforeAll(async () => {
  for (const actor of [owner, office, plant, office]) {
    await withRlsContext(app, { userId: actor.id, role: actor.role, requestId: tag }, (tx) =>
      tx.query(`select audit.record('export', 'viewer_test', null, null, null, $1)`, [tag]),
    );
  }
});

const mine = (rows: { actorUserId: string }[]) => rows.map((r) => r.actorUserId);

describe('audit log viewer (T20)', () => {
  it('the owner sees every event', async () => {
    const page = await listAuditEvents(app, owner, { table: 'viewer_test', reason: tag });
    expect(page.total).toBe(4);
  });

  it('an office user sees only their own events (RLS, not a UI filter)', async () => {
    const page = await listAuditEvents(app, office, { table: 'viewer_test', reason: tag });
    expect(new Set(mine(page.rows))).toEqual(new Set([office.id]));
    expect(page.total).toBe(2);
  });

  it('asking for someone else’s events as office returns nothing', async () => {
    const page = await listAuditEvents(app, office, { table: 'viewer_test', actorId: plant.id });
    expect(page.rows).toEqual([]);
  });

  it('filters by person, action and date, newest first, with pages', async () => {
    const byOffice = await listAuditEvents(app, owner, {
      table: 'viewer_test',
      reason: tag,
      actorId: office.id,
    });
    expect(byOffice.total).toBe(2);
    const paged = await listAuditEvents(app, owner, {
      table: 'viewer_test',
      reason: tag,
      page: 2,
      pageSize: 3,
    });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(4);
    const first = await listAuditEvents(app, owner, { table: 'viewer_test', reason: tag, pageSize: 4 });
    const ids = first.rows.map((r) => BigInt(r.id));
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
    const future = await listAuditEvents(app, owner, { table: 'viewer_test', from: new Date('2099-01-01') });
    expect(future.total).toBe(0);
    const none = await listAuditEvents(app, owner, { table: 'viewer_test', reason: tag, action: 'login' });
    expect(none.total).toBe(0);
  });

  it('caps the page size', async () => {
    const page = await listAuditEvents(app, owner, { pageSize: 10_000 });
    expect(page.pageSize).toBe(100);
  });
});
