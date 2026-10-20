import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createConcreteType,
  listConcreteTypes,
  listSelectableConcreteTypes,
  updateConcreteType,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const code = () => `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

describe('concrete types (master-data T7)', () => {
  it.each(['owner', 'partner', 'office', 'plant'] as const)(
    '%s reads the seeded B12/B20/B25/B30',
    async (role) => {
      const codes = (await listConcreteTypes(app, users[role])).map((t) => t.code);
      expect(codes).toEqual(expect.arrayContaining(['B12', 'B20', 'B25', 'B30']));
    },
  );

  it.each(['owner', 'partner'] as const)(
    '%s creates, relabels and archives a type; audited',
    async (role) => {
      const created = await createConcreteType(app, users[role], {
        code: code().toLowerCase(),
        label: 'Béton test',
      });
      if (!created.ok) throw new Error(created.error);
      expect(created.value.code).toMatch(/^T[A-Z0-9]{6}$/);
      const updated = await updateConcreteType(
        app,
        users[role],
        created.value.id,
        'Béton renommé',
        'archived',
      );
      expect(updated).toMatchObject({ ok: true, value: { label: 'Béton renommé', status: 'archived' } });
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query(
          `select action from audit_event where table_name = 'concrete_type' and row_id = $1 order by id`,
          [created.value.id],
        ),
      );
      expect(rows.map((r) => r.action)).toEqual(['insert', 'update']);
    },
  );

  it('an archived type is still listed but not selectable', async () => {
    const created = await createConcreteType(app, users.owner, { code: code(), label: 'À archiver' });
    if (!created.ok) throw new Error(created.error);
    await updateConcreteType(app, users.owner, created.value.id, 'À archiver', 'archived');
    expect((await listConcreteTypes(app, users.office)).map((t) => t.id)).toContain(created.value.id);
    expect((await listSelectableConcreteTypes(app, users.office)).map((t) => t.id)).not.toContain(
      created.value.id,
    );
  });

  it.each(['office', 'plant'] as const)('%s is refused by the service and by RLS', async (role) => {
    await expect(createConcreteType(app, users[role], { code: code(), label: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      inCtx(users[role], (tx) =>
        tx.query(`insert into concrete_type (id, code, label) values (gen_random_uuid(), 'ZZ9', 'x')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const { rowCount } = await inCtx(users[role], (tx) => tx.query(`update concrete_type set label = 'x'`));
    expect(rowCount).toBe(0);
  });

  it('keeps the code immutable, refuses a duplicate or bad code, and has no DELETE', async () => {
    expect(await createConcreteType(app, users.owner, { code: 'b20', label: 'Doublon' })).toEqual({
      ok: false,
      error: 'DUPLICATE_CODE',
    });
    for (const bad of ['', '20B', 'B 2', 'B-20', 'B'.repeat(11)]) {
      expect(await createConcreteType(app, users.owner, { code: bad, label: 'x' })).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
    await expect(
      inCtx(users.owner, (tx) => tx.query(`update concrete_type set code = 'B99' where code = 'B20'`)),
    ).rejects.toMatchObject({ code: '23000' });
    await expect(inCtx(users.owner, (tx) => tx.query('delete from concrete_type'))).rejects.toMatchObject({
      code: '42501',
    });
  });
});
