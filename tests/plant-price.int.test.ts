import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createOrder } from '../src/modules/ledger';
import { createListPrice, createPlant, type Plant, updatePlant } from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { insertOrder, orderMaster } from './helpers/ledger-fixtures';

// C3 (REQUIREMENTS-V1 §4, D140 revisited): the reference selling price per plant. Both plants are archived at the end.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const marker = 'pr' + randomUUID().replace(/-/g, '').slice(0, 8);
const letters = (n: number) =>
  Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
let owner: SessionUser, office: SessionUser, A: Plant, B: Plant;
let master: Awaited<ReturnType<typeof orderMaster>>;

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
  expect((await migrator.query(`select 1 from plant where status = 'active'`)).rowCount).toBe(0);
  const a = await createPlant(app, owner, { code: letters(6), name: `A ${marker}` });
  if (!a.ok) throw new Error(a.error);
  A = a.value;
  master = await orderMaster(app, owner.id, marker); // the all-plants list price: 78 000 centimes
  const b = await createPlant(app, owner, { code: letters(6), name: `B ${marker}` });
  if (!b.ok) throw new Error(b.error);
  B = b.value;
});
afterAll(async () => {
  for (const p of [A, B]) if (p) await updatePlant(app, owner, p.id, { status: 'archived' });
  await Promise.all([app.end(), migrator.end()]);
});

const input = (plantId: string) => ({
  clientId: master.clientId,
  concreteTypeId: master.typeId,
  plantId,
  volumeL: 5000,
  deliveryDate: '2026-06-10',
  plan: { preset: 'cash' },
});
const unitPriceOf = async (code: string) =>
  Number(
    (
      await migrator.query<{ p: string }>(
        `select unit_price_ht_centimes::text p from sales_order where code = $1`,
        [code],
      )
    ).rows[0]?.p,
  );

describe('reference price per plant (C3)', () => {
  it('only the owner roles publish a plant price; the date must follow the previous one of the same plant', async () => {
    expect(
      await createListPrice(app, owner, {
        concreteTypeId: master.typeId,
        plantId: A.id,
        priceHtPerM3Centimes: 85_000,
        effectiveFrom: '2026-01-01',
      }),
    ).toMatchObject({ ok: true, value: { plantId: A.id, clientId: null } });
    await expect(
      createListPrice(app, office, {
        concreteTypeId: master.typeId,
        plantId: A.id,
        priceHtPerM3Centimes: 1,
        effectiveFrom: '2026-02-01',
      }),
    ).rejects.toThrow();
    // not after the previous version of plant A: refused; the same date for plant B (its own scope): accepted
    expect(
      await createListPrice(app, owner, {
        concreteTypeId: master.typeId,
        plantId: A.id,
        priceHtPerM3Centimes: 86_000,
        effectiveFrom: '2026-01-01',
      }),
    ).toEqual({ ok: false, error: 'NOT_AFTER_LATEST' });
    expect(
      (
        await createListPrice(app, owner, {
          concreteTypeId: master.typeId,
          plantId: B.id,
          priceHtPerM3Centimes: 79_000,
          effectiveFrom: '2026-01-01',
        })
      ).ok,
    ).toBe(true);
  });

  it("an order is made at its own plant's price, by the owner and by the blind office alike", async () => {
    for (const who of [owner, office]) {
      const a = await createOrder(app, who, input(A.id), { today: '2026-06-01' });
      const b = await createOrder(app, who, input(B.id), { today: '2026-06-01' });
      if (!a.ok || !b.ok) throw new Error('order refused');
      expect(await unitPriceOf(a.value.code)).toBe(85_000);
      expect(await unitPriceOf(b.value.code)).toBe(79_000);
    }
  });

  it('the database refuses an order of plant A at another price than the one in force for A', async () => {
    await expect(
      withRlsContext(
        app,
        { userId: owner.id, role: 'owner', requestId: marker, plantId: A.id },
        // the fixture inserts the order at the all-plants price (78 000), which is not the one in force for plant A
        (tx) => insertOrder(tx, owner.id, master),
      ),
    ).rejects.toThrow(/price is not the one in force/);
  });

  it('the reference prices door lists one row per active plant', async () => {
    const rows = await withRlsContext(
      app,
      { userId: owner.id, role: 'owner', requestId: marker },
      async (tx) =>
        (
          await tx.query<{ item_code: string; price_centimes: string; plant_id: string }>(
            `select r.item_code, r.price_centimes::text, r.plant_id::text from public.reference_prices('2026-06-10') r
            where r.kind = 'sell' and r.item_code = (select code from concrete_type where id = $1)`,
            [master.typeId],
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.plant_id, Number(r.price_centimes)]))).toEqual({
      [A.id]: 85_000,
      [B.id]: 79_000,
    });
  });

  it('an archived plant cannot receive a price', async () => {
    const c = await createPlant(app, owner, { code: letters(6), name: `C ${marker}` });
    if (!c.ok) throw new Error(c.error);
    await updatePlant(app, owner, c.value.id, { status: 'archived' });
    expect(
      await createListPrice(app, owner, {
        concreteTypeId: master.typeId,
        plantId: c.value.id,
        priceHtPerM3Centimes: 80_000,
        effectiveFrom: '2026-01-01',
      }),
    ).toEqual({ ok: false, error: 'INACTIVE' });
  });
});
