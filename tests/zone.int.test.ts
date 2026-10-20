import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createZone, listZones, updateZone, type Zone } from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const unique = () => `Zone ${Math.random().toString(36).slice(2, 10)}`;

// Migrations create structure only; each test run starts with no zone.
let existing: Zone;
beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  const created = await createZone(app, users.owner, { name: unique(), oneWayMin: 20 });
  if (!created.ok) throw new Error(created.error);
  existing = created.value;
});

async function auditEvents(actor: SessionUser, rowId: string) {
  const { rows } = await withRlsContext(
    app,
    { userId: actor.id, role: actor.role, requestId: 'test' },
    (tx) =>
      tx.query<{ action: string; before: { one_way_min?: number } | null; after: { one_way_min: number } }>(
        `select action, before, after from audit_event where table_name = 'zone' and row_id = $1 order by id`,
        [rowId],
      ),
  );
  return rows;
}

describe('zones (master-data T2)', () => {
  it.each(['owner', 'partner', 'office', 'plant'] as const)('%s can read the zones', async (role) => {
    expect(await listZones(app, users[role])).toContainEqual(existing);
  });

  it.each(['owner', 'partner'] as const)('%s creates and updates a zone; both are audited', async (role) => {
    const created = await createZone(app, users[role], { name: unique(), oneWayMin: 35 });
    if (!created.ok) throw new Error(created.error);
    const updated = await updateZone(app, users[role], created.value.id, {
      name: created.value.name,
      oneWayMin: 40,
    });
    expect(updated).toMatchObject({ ok: true, value: { oneWayMin: 40 } });
    const events = await auditEvents(users.owner, created.value.id);
    expect(events.map((e) => e.action)).toEqual(['insert', 'update']);
    expect(events[1]).toMatchObject({ before: { one_way_min: 35 }, after: { one_way_min: 40 } });
  });

  it.each(['office', 'plant'] as const)(
    '%s is refused by the service and the refusal is audited',
    async (role) => {
      await expect(createZone(app, users[role], { name: unique(), oneWayMin: 10 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const seeded = (await listZones(app, users.owner))[0];
      await expect(
        updateZone(app, users[role], seeded?.id ?? '', { name: 'Hack', oneWayMin: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await withRlsContext(app, { userId: users[role].id, role, requestId: 'test' }, (tx) =>
        tx.query(`select 1 from audit_event where action = 'permission_denied' and reason = 'zones.write'`),
      );
      expect(rows.length).toBeGreaterThan(0);
    },
  );

  it.each(['office', 'plant'] as const)('%s cannot write even with direct SQL (RLS)', async (role) => {
    const write = (sql: string, params: unknown[] = []) =>
      withRlsContext(app, { userId: users[role].id, role, requestId: 'test' }, (tx) => tx.query(sql, params));
    await expect(
      write('insert into zone (id, name, one_way_min) values (gen_random_uuid(), $1, 5)', [unique()]),
    ).rejects.toMatchObject({ code: '42501' });
    // An UPDATE that RLS hides from the role changes no row instead of raising.
    const { rowCount } = await write(`update zone set one_way_min = 1 where id = $1`, [existing.id]);
    expect(rowCount).toBe(0);
  });

  it('nobody can delete or truncate a zone, not even the owner (AC-MD-06)', async () => {
    const owner = users.owner;
    await expect(
      withRlsContext(app, { userId: owner.id, role: 'owner', requestId: 'test' }, (tx) =>
        tx.query('delete from zone'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('truncate zone')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a duplicate name whatever its case, and invalid input', async () => {
    const name = unique();
    expect((await createZone(app, users.owner, { name, oneWayMin: 15 })).ok).toBe(true);
    expect(await createZone(app, users.partner, { name: name.toUpperCase(), oneWayMin: 15 })).toEqual({
      ok: false,
      error: 'DUPLICATE_NAME',
    });
    expect(await createZone(app, users.owner, { name: '', oneWayMin: 15 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await createZone(app, users.owner, { name: unique(), oneWayMin: 9999 })).toEqual({
      ok: false,
      error: 'INVALID',
    });
  });

  it('answers NOT_FOUND for an unknown or malformed id', async () => {
    const input = { name: unique(), oneWayMin: 10 };
    expect(await updateZone(app, users.owner, '019c0000-0000-7000-8000-0000000000ff', input)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await updateZone(app, users.owner, 'not-a-uuid', input)).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });
});
