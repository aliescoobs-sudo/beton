import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createComponent,
  createPurchaseUnit,
  listComponents,
  listPurchaseUnits,
  updateComponent,
  updatePurchaseUnit,
  type Component,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const unique = () => `Comp ${Math.random().toString(36).slice(2, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function create(user: SessionUser, extra: Record<string, unknown> = {}): Promise<Component> {
  const result = await createComponent(app, user, {
    nameFr: unique(),
    nameAr: 'مكوّن',
    baseUnit: 'g',
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('components and purchase units (master-data T6)', () => {
  it('seeds the six components with their purchase units', async () => {
    const components = await listComponents(app, users.plant);
    expect(components.slice(0, 6).map((c) => c.nameFr)).toEqual([
      'Ciment',
      'Sable',
      'Gravette 8/15',
      'Gravette 15/25',
      'Eau',
      'Adjuvant',
    ]);
    const cement = components[0] as Component;
    const units = (await listPurchaseUnits(app, users.plant)).filter(
      (u) => u.componentId === cement.id && !u.label.startsWith('matrix_'),
    );
    expect(units.map((u) => [u.label, u.factorToBase])).toEqual([
      ['sac 50 kg', 50_000],
      ['t', 1_000_000],
    ]);
  });

  it.each(['owner', 'partner'] as const)(
    '%s creates a component (code generated) and a unit, audited',
    async (role) => {
      const c = await create(users[role]);
      expect(c.code).toMatch(/^CMP-\d{2,}$/);
      const unit = await createPurchaseUnit(app, users[role], c.id, {
        label: 'sac 25 kg',
        factorToBase: 25_000,
      });
      expect(unit).toMatchObject({ ok: true, value: { factorToBase: 25_000 } });
      const { rows } = await inCtx(users.owner, (tx) =>
        tx.query(`select table_name from audit_event where row_id = $1 and action = 'insert'`, [c.id]),
      );
      expect(rows).toEqual([{ table_name: 'component' }]);
    },
  );

  it.each(['office', 'plant'] as const)('%s reads but the service refuses writes (audited)', async (role) => {
    expect((await listComponents(app, users[role])).length).toBeGreaterThanOrEqual(6);
    await expect(
      createComponent(app, users[role], { nameFr: unique(), nameAr: 'x', baseUnit: 'g' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createPurchaseUnit(app, users[role], 'x', { label: 'x', factorToBase: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['office', 'plant'] as const)('%s cannot write with direct SQL (RLS)', async (role) => {
    await expect(
      inCtx(users[role], (tx) =>
        tx.query(
          `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), 'CMP-98', 'x', 'x', 'g')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const { rowCount } = await inCtx(users[role], (tx) => tx.query(`update component set name_fr = name_fr`));
    expect(rowCount).toBe(0);
  });

  it('refuses a fractional, zero or negative factor, and a missing language name (service and CHECK)', async () => {
    const c = await create(users.owner);
    for (const factorToBase of [0, -5, 1.5]) {
      expect(await createPurchaseUnit(app, users.owner, c.id, { label: 'bad', factorToBase })).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into purchase_unit (id, component_id, label, factor_to_base) values (gen_random_uuid(), $1, 'z', 0)`,
          [c.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await createComponent(app, users.owner, { nameFr: unique(), nameAr: '  ', baseUnit: 'g' }),
    ).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(await createComponent(app, users.owner, { nameFr: '', nameAr: 'x', baseUnit: 'g' })).toEqual({
      ok: false,
      error: 'INVALID',
    });
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into component (id, code, name_fr, name_ar, base_unit) values (gen_random_uuid(), 'CMP-97', 'ok', '', 'g')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps code, base unit and factor immutable; names, threshold, label and status change', async () => {
    const c = await create(users.owner, {});
    const unit = await createPurchaseUnit(app, users.owner, c.id, { label: 'sac', factorToBase: 1000 });
    if (!unit.ok) throw new Error(unit.error);
    for (const sql of [
      `update component set code = 'CMP-99' where id = $1`,
      `update component set base_unit = 'L' where id = $1`,
    ]) {
      await expect(inCtx(users.owner, (tx) => tx.query(sql, [c.id]))).rejects.toMatchObject({
        code: '23000',
      });
    }
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(`update purchase_unit set factor_to_base = 2 where id = $1`, [unit.value.id]),
      ),
    ).rejects.toMatchObject({ code: '23000' });
    const updated = await updateComponent(
      app,
      users.partner,
      c.id,
      { nameFr: c.nameFr, nameAr: 'اسم جديد', baseUnit: 'g' },
      'archived',
    );
    expect(updated).toMatchObject({
      ok: true,
      value: { nameAr: 'اسم جديد', status: 'archived' },
    });
    expect(await updatePurchaseUnit(app, users.partner, unit.value.id, 'sac 1 t', 'archived')).toMatchObject({
      ok: true,
      value: { label: 'sac 1 t', status: 'archived', factorToBase: 1000 },
    });
  });

  it('refuses a duplicate name (any case) and an unknown component; nobody can delete', async () => {
    const c = await create(users.owner);
    expect(
      await createComponent(app, users.owner, { nameFr: c.nameFr.toUpperCase(), nameAr: 'x', baseUnit: 'g' }),
    ).toEqual({ ok: false, error: 'DUPLICATE_NAME' });
    expect(
      await createPurchaseUnit(app, users.owner, '019c0000-0000-7000-8000-0000000000ff', {
        label: 'x',
        factorToBase: 1,
      }),
    ).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    for (const table of ['component', 'purchase_unit']) {
      await expect(inCtx(users.owner, (tx) => tx.query(`delete from ${table}`))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });
});
