import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import {
  createConcreteType,
  createListPrice,
  listSellingPrices,
  resolveSellingPriceFor,
  updateConcreteType,
  type ConcreteType,
} from '../src/modules/master-data';
import { ForbiddenError } from '../src/modules/platform-security';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { realSessionUser } from './helpers/actors';
import { testEnv } from './db-env';

const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 2 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function newType(): Promise<ConcreteType> {
  const code = `Q${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  const r = await createConcreteType(app, users.owner, { code, label: 'Béton prix de vente' });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const list = (concreteTypeId: string, priceHtPerM3Centimes: number, effectiveFrom: string) => ({
  concreteTypeId,
  priceHtPerM3Centimes,
  effectiveFrom,
});

describe('selling prices: list (master-data T11, AC-MD-03)', () => {
  it('versions by effective_from: a new list price leaves earlier dates on the old one', async () => {
    const type = await newType();
    const v1 = await createListPrice(app, users.owner, list(type.id, 90_000, '2026-01-01'));
    const v2 = await createListPrice(app, users.owner, list(type.id, 95_000, '2026-06-01'));
    if (!v1.ok || !v2.ok) throw new Error('create failed');
    expect(await resolveSellingPriceFor(app, users.support, type.id, null, '2026-05-31')).toMatchObject({
      ok: true,
      value: { id: v1.value.id, priceHtPerM3Centimes: 90_000, clientId: null },
    });
    expect(await resolveSellingPriceFor(app, users.support, type.id, null, '2026-06-01')).toMatchObject({
      ok: true,
      value: { id: v2.value.id },
    });
  });

  it('returns NO_PRICE (never 0) before the first price and for a type with none', async () => {
    const type = await newType();
    expect(await resolveSellingPriceFor(app, users.owner, type.id, null, '2026-01-01')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
    await createListPrice(app, users.owner, list(type.id, 1, '2026-03-01'));
    expect(await resolveSellingPriceFor(app, users.owner, type.id, null, '2026-02-28')).toEqual({
      ok: false,
      error: 'NO_PRICE',
    });
  });

  it('refuses a date not after the last version, bad input, an unknown and an archived type', async () => {
    const type = await newType();
    expect((await createListPrice(app, users.owner, list(type.id, 5, '2026-03-01'))).ok).toBe(true);
    for (const date of ['2026-03-01', '2026-01-01']) {
      expect(await createListPrice(app, users.owner, list(type.id, 6, date))).toEqual({
        ok: false,
        error: 'NOT_AFTER_LATEST',
      });
    }
    for (const bad of [1.5, 0, -1]) {
      expect(await createListPrice(app, users.owner, list(type.id, bad, '2026-09-01'))).toEqual({
        ok: false,
        error: 'INVALID',
      });
    }
    expect(
      await createListPrice(app, users.owner, list('019c0000-0000-7000-8000-0000000000ff', 5, '2026-09-01')),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
    await updateConcreteType(app, users.owner, type.id, type.label, 'archived');
    expect(await createListPrice(app, users.owner, list(type.id, 5, '2026-09-01'))).toEqual({
      ok: false,
      error: 'INACTIVE',
    });
    expect(await listSellingPrices(app, users.owner, { concreteTypeId: type.id })).toHaveLength(1);
  });

  it.each(['partner', 'office', 'plant', 'support'] as const)(
    '%s cannot write a list price (service and RLS)',
    async (role) => {
      const type = await newType();
      await expect(createListPrice(app, users[role], list(type.id, 5, '2026-01-01'))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        inCtx(users[role], (tx) =>
          tx.query(
            `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
           values (gen_random_uuid(), $1, null, 5, '2030-01-01', $2)`,
            [type.id, users[role].id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('owner and support read; partner, office and plant see nothing at all (AC-MD-07, DECISIONS 81)', async () => {
    const type = await newType();
    await createListPrice(app, users.owner, list(type.id, 5, '2026-01-01'));
    for (const role of ['owner', 'support'] as const) {
      expect(await listSellingPrices(app, users[role], { concreteTypeId: type.id })).toHaveLength(1);
    }
    for (const role of ['partner', 'office', 'plant'] as const) {
      await expect(listSellingPrices(app, users[role])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        resolveSellingPriceFor(app, users[role], type.id, null, '2026-06-01'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await inCtx(users[role], (tx) => tx.query(`select * from selling_price`));
      expect(rows).toEqual([]);
    }
  });

  it('is insert-only: no UPDATE or DELETE', async () => {
    const type = await newType();
    await createListPrice(app, users.owner, list(type.id, 5, '2026-01-01'));
    for (const sql of [
      `update selling_price set price_ht_per_m3_centimes = 1`,
      `delete from selling_price`,
    ]) {
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });
});
