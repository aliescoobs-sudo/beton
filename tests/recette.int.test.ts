import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createConcreteType,
  createRecetteVersion,
  listComponents,
  listRecetteVersions,
  resolveRecetteFor,
  updateComponent,
  createComponent,
  type Component,
  type ConcreteType,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
let cement: Component;
let sand: Component;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  const components = await listComponents(app, users.owner);
  cement = components.find((c) => c.nameFr === 'Ciment') as Component;
  sand = components.find((c) => c.nameFr === 'Sable') as Component;
});

async function newType(): Promise<ConcreteType> {
  const code = `V${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  const r = await createConcreteType(app, users.owner, { code, label: 'Béton test' });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const lines = (cementQty: number, sandQty = 800_000) => [
  { componentId: cement.id, qtyPerM3: cementQty },
  { componentId: sand.id, qtyPerM3: sandQty },
];

describe('recette versions (master-data T8, AC-MD-02)', () => {
  it('a version at D leaves earlier dates on the old version; stored ids never change', async () => {
    const type = await newType();
    const v1 = await createRecetteVersion(app, users.owner, type.id, {
      effectiveFrom: '2026-01-01',
      lines: lines(300_000),
    });
    const v2 = await createRecetteVersion(app, users.partner, type.id, {
      effectiveFrom: '2026-06-01',
      lines: lines(350_000),
    });
    if (!v1.ok || !v2.ok) throw new Error('create failed');
    expect([v1.value.version, v2.value.version]).toEqual([1, 2]);

    const before = await resolveRecetteFor(app, users.plant, type.id, '2026-05-31');
    expect(before).toMatchObject({ ok: true, value: { id: v1.value.id, version: 1 } });
    expect(await resolveRecetteFor(app, users.plant, type.id, '2026-06-01')).toMatchObject({
      ok: true,
      value: { id: v2.value.id },
    });
    expect(await resolveRecetteFor(app, users.plant, type.id, '2025-12-31')).toEqual({
      ok: false,
      error: 'NO_RECETTE',
    });
    const stored = (await listRecetteVersions(app, users.office, type.id)).find((v) => v.version === 1);
    expect(stored?.lines).toContainEqual({ componentId: cement.id, qtyPerM3: 300_000 });
  });

  it('refuses a date not after the previous version, bad input and an unknown type', async () => {
    const type = await newType();
    expect(
      (
        await createRecetteVersion(app, users.owner, type.id, {
          effectiveFrom: '2026-03-01',
          lines: lines(1),
        })
      ).ok,
    ).toBe(true);
    for (const date of ['2026-03-01', '2026-02-01']) {
      expect(
        await createRecetteVersion(app, users.owner, type.id, { effectiveFrom: date, lines: lines(1) }),
      ).toEqual({
        ok: false,
        error: 'NOT_AFTER_LATEST',
      });
    }
    expect(
      await createRecetteVersion(app, users.owner, type.id, {
        effectiveFrom: '2026-09-01',
        lines: lines(1.5),
      }),
    ).toEqual({
      ok: false,
      error: 'INVALID',
    });
    expect(
      await createRecetteVersion(app, users.owner, '019c0000-0000-7000-8000-0000000000ff', {
        effectiveFrom: '2026-09-01',
        lines: lines(1),
      }),
    ).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await listRecetteVersions(app, users.owner, type.id)).toHaveLength(1);
  });

  it('refuses an archived component, and rolls back (no half recette)', async () => {
    const type = await newType();
    const made = await createComponent(app, users.owner, {
      nameFr: `Arch ${Math.random()}`,
      nameAr: 'x',
      baseUnit: 'g',
    });
    if (!made.ok) throw new Error(made.error);
    await updateComponent(
      app,
      users.owner,
      made.value.id,
      { nameFr: made.value.nameFr, nameAr: 'x', baseUnit: 'g' },
      'archived',
    );
    const result = await createRecetteVersion(app, users.owner, type.id, {
      effectiveFrom: '2026-01-01',
      lines: [{ componentId: made.value.id, qtyPerM3: 5 }],
    });
    expect(result).toEqual({ ok: false, error: 'INACTIVE_COMPONENT' });
    expect(await listRecetteVersions(app, users.owner, type.id)).toEqual([]);
  });

  it.each(['office', 'plant'] as const)('%s reads but cannot publish (service and RLS)', async (role) => {
    const type = await newType();
    await expect(
      createRecetteVersion(app, users[role], type.id, { effectiveFrom: '2026-01-01', lines: lines(1) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inCtx(users[role], (tx) =>
        tx.query(
          `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 1, '2030-01-01', $2)`,
          [type.id, users[role].id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('is insert-only: no UPDATE or DELETE on either table, lines cannot be added to a published recette', async () => {
    const type = await newType();
    const v = await createRecetteVersion(app, users.owner, type.id, {
      effectiveFrom: '2026-01-01',
      lines: lines(1),
    });
    if (!v.ok) throw new Error(v.error);
    for (const sql of [
      `update recette set effective_from = '2027-01-01'`,
      `delete from recette`,
      `update recette_line set qty_per_m3 = 2`,
      `delete from recette_line`,
    ]) {
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    const other = await createComponent(app, users.owner, {
      nameFr: `Late ${Math.random()}`,
      nameAr: 'x',
      baseUnit: 'g',
    });
    if (!other.ok) throw new Error(other.error);
    await expect(
      inCtx(users.owner, (tx) =>
        tx.query(
          `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, $2, 5)`,
          [v.value.id, other.value.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23000' });
  });

  it('refuses a zero quantity at the database', async () => {
    const type = await newType();
    await expect(
      inCtx(users.owner, async (tx) => {
        const id = '019c0000-0000-7000-8000-0000000000aa';
        await tx.query(
          `insert into recette (id, concrete_type_id, version, effective_from, created_by) values ($1, $2, 1, '2026-01-01', $3)`,
          [id, type.id, users.owner.id],
        );
        await tx.query(
          `insert into recette_line (id, recette_id, component_id, qty_per_m3) values (gen_random_uuid(), $1, $2, 0)`,
          [id, cement.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
