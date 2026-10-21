import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  componentCostPerM3For,
  createComponent,
  createConcreteType,
  createPurchasePrice,
  createPurchaseUnit,
  createRecetteVersion,
  createSupplier,
  listPurchasePrices,
  proposePriceFromLastPurchase,
  updateComponent,
  type Component,
  type ConcreteType,
  type PurchaseUnit,
  type Supplier,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { realSessionUser } from './helpers/actors';
import { testEnv } from './db-env';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const rand = () => Math.random().toString(36).slice(2, 9).toUpperCase();
let supplier: Supplier;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  const s = await createSupplier(app, users.owner, { name: `Fournisseur prix ${rand()}`, category: 'other' });
  if (!s.ok) throw new Error(s.error);
  supplier = s.value;
});

async function newComponent(): Promise<{ component: Component; kg: PurchaseUnit; tonne: PurchaseUnit }> {
  const c = await createComponent(app, users.owner, { nameFr: `Comp ${rand()}`, nameAr: 'x', baseUnit: 'g' });
  if (!c.ok) throw new Error(c.error);
  const kg = await createPurchaseUnit(app, users.owner, c.value.id, { label: 'kg', factorToBase: 1000 });
  const tonne = await createPurchaseUnit(app, users.owner, c.value.id, {
    label: 't',
    factorToBase: 1_000_000,
  });
  if (!kg.ok || !tonne.ok) throw new Error('unit');
  return { component: c.value, kg: kg.value, tonne: tonne.value };
}

async function typeWith(lines: { componentId: string; qtyPerM3: number }[]): Promise<ConcreteType> {
  const t = await createConcreteType(app, users.owner, { code: `P${rand()}`, label: 'Béton prix' });
  if (!t.ok) throw new Error(t.error);
  const r = await createRecetteVersion(app, users.owner, t.value.id, { effectiveFrom: '2026-01-01', lines });
  if (!r.ok) throw new Error(r.error);
  return t.value;
}

const price = (
  componentId: string,
  purchaseUnitId: string,
  priceHtCentimes: number,
  effectiveFrom = '2026-01-01',
) => ({ componentId, supplierId: supplier.id, purchaseUnitId, priceHtCentimes, effectiveFrom });

describe('purchase prices and cost per m³ (master-data T10, AC-MD-04)', () => {
  it('2.5 t at 1 450,00 MAD/t HT costs 3 625,00 MAD, through the service', async () => {
    const { component, tonne } = await newComponent();
    const made = await createPurchasePrice(app, users.owner, price(component.id, tonne.id, 145_000));
    expect(made.ok).toBe(true);
    const type = await typeWith([{ componentId: component.id, qtyPerM3: 2_500_000 }]);
    expect(await componentCostPerM3For(app, users.partner, type.id, '2026-06-01')).toEqual({
      ok: true,
      value: 362_500,
    });
  });

  it('is an integer, and the same price per kg or per tonne agrees within a centime', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (qty, perKg) => {
          const x = await newComponent();
          await createPurchasePrice(app, users.owner, price(x.component.id, x.kg.id, perKg));
          const y = await newComponent();
          await createPurchasePrice(app, users.owner, price(y.component.id, y.tonne.id, perKg * 1000));
          const tx = await typeWith([{ componentId: x.component.id, qtyPerM3: qty }]);
          const ty = await typeWith([{ componentId: y.component.id, qtyPerM3: qty }]);
          const cx = await componentCostPerM3For(app, users.owner, tx.id, '2026-02-01');
          const cy = await componentCostPerM3For(app, users.owner, ty.id, '2026-02-01');
          if (!cx.ok || !cy.ok) throw new Error('no cost');
          expect(Number.isSafeInteger(cx.value)).toBe(true);
          expect(Math.abs(cx.value - cy.value)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 8 },
    );
  }, 60_000);

  it('a new version at D leaves earlier dates on the old price; no price is an error, never 0', async () => {
    const { component, kg } = await newComponent();
    const type = await typeWith([{ componentId: component.id, qtyPerM3: 10_000 }]);
    expect(await componentCostPerM3For(app, users.owner, type.id, '2026-06-01')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
    await createPurchasePrice(app, users.owner, price(component.id, kg.id, 200, '2026-01-01'));
    await createPurchasePrice(app, users.partner, price(component.id, kg.id, 300, '2026-06-01'));
    expect(await componentCostPerM3For(app, users.owner, type.id, '2026-05-31')).toEqual({
      ok: true,
      value: 2000,
    });
    expect(await componentCostPerM3For(app, users.owner, type.id, '2026-06-01')).toEqual({
      ok: true,
      value: 3000,
    });
    expect(await componentCostPerM3For(app, users.owner, type.id, '2025-12-31')).toEqual({
      ok: false,
      error: 'NO_RECETTE',
    });
  });

  it('refuses a date not after the last version, a foreign unit, an archived component and bad input', async () => {
    const { component, kg } = await newComponent();
    const other = await newComponent();
    expect((await createPurchasePrice(app, users.owner, price(component.id, kg.id, 5))).ok).toBe(true);
    for (const date of ['2026-01-01', '2025-06-01']) {
      expect(await createPurchasePrice(app, users.owner, price(component.id, kg.id, 6, date))).toEqual({
        ok: false,
        error: 'NOT_AFTER_LATEST',
      });
    }
    expect(
      await createPurchasePrice(app, users.owner, price(component.id, other.kg.id, 6, '2026-09-01')),
    ).toEqual({ ok: false, error: 'UNIT_MISMATCH' });
    expect(
      await createPurchasePrice(app, users.owner, {
        ...price(component.id, kg.id, 6, '2026-09-01'),
        priceHtCentimes: 1.5,
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await createPurchasePrice(app, users.owner, { ...price(component.id, kg.id, 0, '2026-09-01') }),
    ).toEqual({ ok: false, error: 'INVALID' });
    await updateComponent(
      app,
      users.owner,
      other.component.id,
      { nameFr: other.component.nameFr, nameAr: 'x', baseUnit: 'g' },
      'archived',
    );
    expect(await createPurchasePrice(app, users.owner, price(other.component.id, other.kg.id, 6))).toEqual({
      ok: false,
      error: 'INACTIVE',
    });
    expect(await listPurchasePrices(app, users.owner, component.id)).toHaveLength(1);
  });

  it('the stub proposal returns the last price (or nothing)', async () => {
    const { component, kg } = await newComponent();
    expect(await proposePriceFromLastPurchase(app, users.owner, component.id)).toBeNull();
    await createPurchasePrice(app, users.owner, price(component.id, kg.id, 7, '2026-01-01'));
    await createPurchasePrice(app, users.owner, price(component.id, kg.id, 9, '2026-03-01'));
    expect(await proposePriceFromLastPurchase(app, users.owner, component.id)).toMatchObject({
      priceHtCentimes: 9,
      effectiveFrom: '2026-03-01',
    });
  });

  it.each(['office', 'plant'] as const)('%s cannot write a price (service and RLS)', async (role) => {
    const { component, kg } = await newComponent();
    await expect(createPurchasePrice(app, users[role], price(component.id, kg.id, 5))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      inCtx(users[role], (tx) =>
        tx.query(
          `insert into purchase_price (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by)
           values (gen_random_uuid(), $1, $2, $3, 5, '2030-01-01', $4)`,
          [component.id, supplier.id, kg.id, users[role].id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('office reads the prices but not the cost per m³; the plant sees nothing at all (AC-MD-07)', async () => {
    const { component, kg } = await newComponent();
    await createPurchasePrice(app, users.owner, price(component.id, kg.id, 5));
    expect(await listPurchasePrices(app, users.office, component.id)).toHaveLength(1);
    const type = await typeWith([{ componentId: component.id, qtyPerM3: 1000 }]);
    await expect(componentCostPerM3For(app, users.office, type.id, '2026-06-01')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listPurchasePrices(app, users.plant)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(componentCostPerM3For(app, users.plant, type.id, '2026-06-01')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const { rows } = await inCtx(users.plant, (tx) => tx.query(`select * from purchase_price`));
    expect(rows).toEqual([]);
  });

  it('is insert-only: no UPDATE or DELETE', async () => {
    const { component, kg } = await newComponent();
    await createPurchasePrice(app, users.owner, price(component.id, kg.id, 5));
    for (const sql of [`update purchase_price set price_ht_centimes = 1`, `delete from purchase_price`]) {
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });
});
