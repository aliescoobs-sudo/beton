import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asDryRun, inRequest, inRequestRolledBack, type SessionUser } from '../src/modules/platform-security';
import { createZone } from '../src/modules/master-data';
import { verifyAuditChain } from '../src/modules/platform-security/service/audit-chain';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// assistant A7: the rehearsal. A draft is previewed by the service that will run at confirmation, in a transaction that rolls back.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

let owner: SessionUser;
beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
});

const zoneCount = async () =>
  Number((await inRequest(app, owner, (tx) => tx.query(`select count(*)::int as n from zone`))).rows[0].n);
const auditCount = async () =>
  Number((await migrator.query('select count(*)::int as n from audit_event')).rows[0].n);

describe('asDryRun', () => {
  it('lets a service do its work, return its result, and leaves nothing: no row, no audit event', async () => {
    const before = { zones: await zoneCount(), audit: await auditCount() };
    const result = await asDryRun(() =>
      inRequest(app, owner, async (tx) => {
        await tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 20)`, [
          `dry-${randomUUID()}`,
        ]);
        return (await tx.query(`select count(*)::int as n from zone`)).rows[0].n as number;
      }),
    );
    expect(result).toBe(before.zones + 1);
    expect(await zoneCount()).toBe(before.zones);
    expect(await auditCount()).toBe(before.audit);
  });

  it('rolls back what a real service of the application writes', async () => {
    const name = `dry-${randomUUID()}`;
    const made = await asDryRun(() => createZone(app, owner, { name, oneWayMin: 25 }));
    expect(made.ok).toBe(true);
    const { rows } = await inRequest(app, owner, (tx) =>
      tx.query('select 1 from zone where name = $1', [name]),
    );
    expect(rows).toEqual([]);
  });

  it('does not leak into the next request: outside it, a write stays', async () => {
    await asDryRun(() => inRequest(app, owner, (tx) => tx.query('select 1')));
    const name = `kept-${randomUUID()}`;
    await inRequest(app, owner, (tx) =>
      tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 20)`, [name]),
    );
    const seen = await inRequest(app, owner, (tx) => tx.query('select 1 from zone where name = $1', [name]));
    expect(seen.rowCount).toBe(1);
  });
});

describe('inRequestRolledBack', () => {
  it('returns what the transaction saw of what it wrote, then forgets it', async () => {
    const before = await zoneCount();
    const seen = await inRequestRolledBack(app, owner, async (tx) => {
      await tx.query(`insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 20)`, [
        `rb-${randomUUID()}`,
      ]);
      return (await tx.query(`select count(*)::int as n from zone`)).rows[0].n as number;
    });
    expect(seen).toBe(before + 1);
    expect(await zoneCount()).toBe(before);
  });

  it('passes an error through, and keeps the audit chain verifiable after all the rehearsals', async () => {
    await expect(
      inRequestRolledBack(app, owner, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const client = await migrator.connect();
    try {
      expect(await verifyAuditChain(client)).toMatchObject({ ok: true });
    } finally {
      client.release();
    }
  });
});
