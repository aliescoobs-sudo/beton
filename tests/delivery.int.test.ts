import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRlsContext } from '../src/lib/db/rls-context';
import { cancelOrder } from '../src/modules/ledger';
import {
  cancelLoad,
  confirmExcess,
  createLoad,
  listExcesses,
  recordBlReturn,
} from '../src/modules/operations';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { setParameter } from '../src/modules/platform-security/service/parameter-service';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { expectNoFields } from './helpers/expect-no-fields';
import {
  insertDelivery,
  insertOrderWithItems,
  orderMaster,
  type OrderMaster,
} from './helpers/ledger-fixtures';

// operations O2: loads, BL numbers, the BL return. AC-OPS-01, AC-OPS-08, AC-OPS-10; prices never appear.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 8 });
afterAll(() => app.end());

const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const marker = `dlv${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: marker }, fn);
const TODAY = '2026-06-01';
let master: OrderMaster;
let truckId: string;
let recetteId: string;

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
  master = await orderMaster(app, users.owner.id, marker);
  await inCtx(users.owner, async (tx) => {
    truckId = (await tx.query<{ id: string }>(`select id from truck where code = 'T1'`)).rows[0]
      ?.id as string;
    recetteId = (
      await tx.query<{ id: string }>(
        `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 1, '2000-01-01', $2) returning id`,
        [master.typeId, users.owner.id],
      )
    ).rows[0]?.id as string;
  });
});

/** A fresh client with an order of `volumeL` litres (10 m³ by default), by the owner. */
async function order(options: { zoneId?: string; volumeL?: number } = {}) {
  return inCtx(users.owner, async (tx) => {
    const client = await tx.query<{ id: string }>(
      `insert into client (id, code, name, kind) values (gen_random_uuid(), public.next_code('CLT', 3), $1, 'person') returning id`,
      [`dlv ${randomUUID()}`],
    );
    return insertOrderWithItems(tx, users.owner.id, master, client.rows[0]?.id as string, [936_000], options);
  });
}
const load = (actor: SessionUser, orderId: string, volumeL?: number, today = TODAY, truck = truckId) =>
  createLoad(app, actor, { orderId, truckId: truck, volumeL }, { today });

describe('createLoad (AC-OPS-01)', () => {
  it('a plant load gets a BL number and the recette in force, and returns no price', async () => {
    const o = await order();
    const r = await load(users.plant, o.id, 4000);
    expect(r).toMatchObject({ ok: true, value: { volumeL: 4000, warnings: [] } });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.blNo).toMatch(/^BL-2026-\d{5,}$/);
    expectNoFields(r.value, ['unitPrice', 'price', 'total', 'totalTtcCentimes', 'amountCentimes']);
    const row = (
      await inCtx(users.plant, (tx) =>
        tx.query<{ recette_id: string; volume_l: number }>(
          'select recette_id, volume_l from delivery where id = $1',
          [r.value.id],
        ),
      )
    ).rows[0];
    expect(row).toEqual({ recette_id: recetteId, volume_l: 4000 });
  });

  it('defaults to the smaller of what is left and the truck capacity (8 m³)', async () => {
    const o = await order();
    expect((await load(users.plant, o.id)).ok && 8000).toBe(8000);
    const second = await load(users.plant, o.id);
    expect(second).toMatchObject({ ok: true, value: { volumeL: 2000 } });
    // nothing left and no volume asked: it asks for a volume
    expect(await load(users.plant, o.id)).toEqual({ ok: false, error: 'OVER_ORDER' });
  });

  it('refuses more than the truck carries; more than what is left of the order is allowed, warned about and recorded (review point 4)', async () => {
    const o = await order();
    expect(await load(users.plant, o.id, 9000)).toEqual({ ok: false, error: 'OVER_CAPACITY' });
    expect((await load(users.plant, o.id, 8000)).ok).toBe(true);
    // 2 m³ left: 3 m³ goes 1 m³ past the order, more than the 5 % tolerance (0,5 m³)
    const over = await load(users.plant, o.id, 3000);
    expect(over).toMatchObject({
      ok: true,
      value: { volumeL: 3000, excessL: 1000, warnings: ['OVER_ORDER'] },
    });
    await expect(
      inCtx(users.plant, (tx) =>
        insertDelivery(tx, users.plant.id, { orderId: o.id, truckId, recetteId }, 9000),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a small excess within the tolerance is only a minor warning; the database records both, nothing else writes the record', async () => {
    const o = await order();
    expect((await load(users.plant, o.id, 8000)).ok).toBe(true);
    const minor = await load(users.plant, o.id, 2400); // 400 L past 10 000: within 5 %
    expect(minor).toMatchObject({ ok: true, value: { excessL: 400, warnings: ['OVER_ORDER_MINOR'] } });
    const rows = await inCtx(users.owner, (tx) =>
      tx.query<{ excess_l: number }>(
        'select x.excess_l from delivery_excess x join delivery d on d.id = x.delivery_id where d.order_id = $1',
        [o.id],
      ),
    );
    expect(rows.rows).toEqual([{ excess_l: 400 }]);
    await expect(
      inCtx(users.plant, (tx) =>
        tx.query(
          `insert into delivery_excess (id, delivery_id, excess_l, created_by) values (gen_random_uuid(), gen_random_uuid(), 1, $1)`,
          [users.plant.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the owner confirms an excess once, with a note; partner reads, plant and office do not confirm', async () => {
    const o = await order();
    await load(users.plant, o.id, 8000);
    await load(users.plant, o.id, 4000); // 2 000 L past the order
    const list = async (u: SessionUser) => (await listExcesses(app, u)).filter((x) => x.orderCode === o.code);
    const [first] = await list(users.owner);
    expect(first).toMatchObject({
      excessL: 2000,
      minor: false,
      confirmed: false,
      orderL: 10_000,
      loadedL: 12_000,
    });
    expect((await list(users.partner)).length).toBe(1);
    expect((await list(users.support)).length).toBe(1);
    await expect(listExcesses(app, users.plant)).rejects.toBeDefined();
    for (const u of [users.plant, users.office, users.partner, users.support])
      await expect(confirmExcess(app, u, { excessId: first?.id })).rejects.toBeDefined();
    expect(
      await confirmExcess(app, users.owner, { excessId: first?.id, note: 'accord verbal du client' }),
    ).toMatchObject({ ok: true });
    expect(await confirmExcess(app, users.owner, { excessId: first?.id })).toEqual({
      ok: false,
      error: 'ALREADY_CONFIRMED',
    });
    expect((await list(users.owner))[0]).toMatchObject({
      confirmed: true,
      confirmedNote: 'accord verbal du client',
    });
    expect(await confirmExcess(app, users.owner, { excessId: randomUUID() })).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  it('an excess load that is cancelled no longer counts', async () => {
    const o = await order();
    await load(users.plant, o.id, 8000);
    const over = await load(users.plant, o.id, 4000);
    if (!over.ok) throw new Error(over.error);
    expect((await listExcesses(app, users.owner)).filter((x) => x.orderCode === o.code)).toHaveLength(1);
    const cancelled = await cancelLoad(
      app,
      users.owner,
      { deliveryId: over.value.id, reason: 'erreur de saisie' },
      { today: TODAY },
    );
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
    expect((await listExcesses(app, users.owner)).filter((x) => x.orderCode === o.code)).toHaveLength(0);
  });

  it('refuses a cancelled order, an unknown order or truck, and a type with no recette in force', async () => {
    const o = await order();
    expect(
      (await cancelOrder(app, users.owner, o.id, 'annulée avant livraison', {}, { today: TODAY })).ok,
    ).toBe(true);
    expect(await load(users.plant, o.id, 1000)).toEqual({ ok: false, error: 'ORDER_CANCELLED' });
    expect(await load(users.plant, randomUUID(), 1000)).toEqual({ ok: false, error: 'NOT_FOUND' });
    const live = await order();
    expect(await load(users.plant, live.id, 1000, TODAY, randomUUID())).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    // The recette starts in 2000: nothing is in force in 1999.
    expect(await load(users.plant, live.id, 1000, '1999-12-31')).toEqual({ ok: false, error: 'NO_RECETTE' });
  });

  it('stores the version in force on the load date; a later version does not change a past load', async () => {
    const o = await order();
    const v2 = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string }>(
        `insert into recette (id, concrete_type_id, version, effective_from, created_by) values (gen_random_uuid(), $1, 2, '2026-09-01', $2) returning id`,
        [master.typeId, users.owner.id],
      ),
    );
    const before = await load(users.plant, o.id, 1000, '2026-08-31');
    const after = await load(users.plant, o.id, 1000, '2026-09-01');
    if (!before.ok || !after.ok) throw new Error('setup');
    const ids = await inCtx(users.owner, (tx) =>
      tx.query<{ id: string; recette_id: string }>('select id, recette_id from delivery where id = any($1)', [
        [before.value.id, after.value.id],
      ]),
    );
    const byId = new Map(ids.rows.map((r) => [r.id, r.recette_id]));
    expect(byId.get(before.value.id)).toBe(recetteId);
    expect(byId.get(after.value.id)).toBe(v2.rows[0]?.id);
    // The database refuses a load that names another version than the one in force.
    await expect(
      inCtx(users.plant, (tx) =>
        insertDelivery(
          tx,
          users.plant.id,
          { orderId: o.id, truckId, recetteId: v2.rows[0]?.id as string },
          100,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('5 loads of 3 m³ at once on a 10 m³ order: none is refused, and the excess recorded adds up to exactly 5 m³ (no race)', async () => {
    const o = await order();
    const results = await Promise.all(Array.from({ length: 5 }, () => load(users.plant, o.id, 3000)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const sum = await inCtx(users.owner, (tx) =>
      tx.query<{ s: string; x: string }>(
        `select (select sum(volume_l) from delivery where order_id = $1)::text as s,
                (select coalesce(sum(x.excess_l), 0) from delivery_excess x join delivery d on d.id = x.delivery_id where d.order_id = $1)::text as x`,
        [o.id],
      ),
    );
    expect(sum.rows[0]).toEqual({ s: '15000', x: '5000' });
  });

  it('numbers delivery notes without a gap', async () => {
    const o = await order();
    const a = await load(users.plant, o.id, 1000);
    const b = await load(users.partner, o.id, 1000);
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(Number(b.value.blNo.split('-')[2]) - Number(a.value.blNo.split('-')[2])).toBe(1);
  });

  it('partner and owner can load; office and support cannot', async () => {
    const o = await order();
    expect((await load(users.partner, o.id, 500)).ok).toBe(true);
    expect((await load(users.owner, o.id, 500)).ok).toBe(true);
    for (const role of ['office', 'support'] as const)
      await expect(load(users[role], o.id, 500)).rejects.toThrow();
  });

  it('plant and partner may number delivery notes and nothing else', async () => {
    for (const role of ['plant', 'partner'] as const) {
      expect(
        (await inCtx(users[role], (tx) => tx.query(`select public.next_doc_number('BL', 2026, 5)`))).rows,
      ).toHaveLength(1);
      for (const prefix of ['CMD', 'ACH', 'FA'])
        await expect(
          inCtx(users[role], (tx) => tx.query(`select public.next_doc_number($1, 2026, 5)`, [prefix])),
        ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      inCtx(users.support, (tx) => tx.query(`select public.next_doc_number('BL', 2026, 5)`)),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the 90-minute rule (AC-OPS-08)', () => {
  it('Oued Laou (60 min) + 30 min unloading: no warning at a limit of 90, a warning at 85', async () => {
    const zone = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>(`select id from zone where name = 'Oued Laou'`),
      )
    ).rows[0]?.id;
    const o = await order({ zoneId: zone });
    const ok = await load(users.plant, o.id, 1000);
    expect(ok).toMatchObject({ ok: true, value: { warnings: [] } });
    await setParameter(app, users.owner, 'concrete_limit_min', 85);
    try {
      const warned = await load(users.plant, o.id, 1000);
      expect(warned).toMatchObject({ ok: true, value: { warnings: ['LONG_TRIP'] } });
    } finally {
      await setParameter(app, users.owner, 'concrete_limit_min', 90);
    }
  });
});

describe('cancelling a load: the database rules', () => {
  const reverse = (
    actor: SessionUser,
    of: { id: string; order_id: string; truck_id: string; recette_id: string; volume_l: number },
    volume = -of.volume_l,
  ) =>
    inCtx(actor, async (tx) => {
      const bl = (await tx.query<{ n: string }>(`select public.next_doc_number('BL', 2026, 5) as n`)).rows[0]
        ?.n;
      return tx.query(
        `insert into delivery (id, bl_no, order_id, truck_id, volume_l, load_date, recette_id, reverses_id, reason, created_by)
         values (gen_random_uuid(), $1, $2, $3, $4, '2026-06-01', $5, $6, 'chargement erroné', $7)`,
        [bl, of.order_id, of.truck_id, volume, of.recette_id, of.id, actor.id],
      );
    });
  const fetch = async (id: string) =>
    (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string; order_id: string; truck_id: string; recette_id: string; volume_l: number }>(
          'select id, order_id, truck_id, recette_id, volume_l from delivery where id = $1',
          [id],
        ),
      )
    ).rows[0] as {
      id: string;
      order_id: string;
      truck_id: string;
      recette_id: string;
      volume_l: number;
    };

  it('owner and partner cancel with an exact negation, once; a plant cannot; a reversal cannot be reversed', async () => {
    const o = await order();
    const l = await load(users.plant, o.id, 2000);
    if (!l.ok) throw new Error('setup');
    const original = await fetch(l.value.id);
    await expect(reverse(users.plant, original)).rejects.toMatchObject({ code: '42501' });
    await expect(
      cancelLoad(app, users.plant, { deliveryId: l.value.id, reason: 'erreur de saisie' }, { today: TODAY }),
    ).rejects.toThrow();
    await expect(reverse(users.owner, original, -1999)).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await cancelLoad(
          app,
          users.partner,
          { deliveryId: l.value.id, reason: 'chargement erroné' },
          { today: TODAY },
        )
      ).ok,
    ).toBe(true);
    await expect(reverse(users.owner, original)).rejects.toMatchObject({ code: '23505' });
    expect(
      await cancelLoad(app, users.owner, { deliveryId: l.value.id, reason: 'encore' }, { today: TODAY }),
    ).toEqual({ ok: false, error: 'ALREADY_CANCELLED' });
    const rev = (
      await inCtx(users.owner, (tx) =>
        tx.query<{ id: string }>('select id from delivery where reverses_id = $1', [original.id]),
      )
    ).rows[0] as { id: string };
    await expect(
      reverse(users.owner, { ...original, id: rev.id, volume_l: -2000 }, 2000),
    ).rejects.toMatchObject({ code: '23514' });
    // The cancelled load gives its volume back to the order.
    expect((await load(users.plant, o.id, 8000)).ok).toBe(true);
  });

  it('nobody edits or deletes a load or a return', async () => {
    for (const sql of [
      'update delivery set volume_l = 1',
      'delete from delivery',
      'update delivery_return set returned_volume_l = 1',
      'delete from delivery_return',
      'truncate delivery',
    ])
      await expect(inCtx(users.owner, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the signed BL return (AC-OPS-10)', () => {
  it('is recorded once; a second attempt, by office, learns who recorded it and when', async () => {
    const o = await order();
    const l = await load(users.plant, o.id, 2000);
    if (!l.ok) throw new Error('setup');
    const first = await recordBlReturn(app, users.plant, {
      deliveryId: l.value.id,
      returnedOn: '2026-06-02',
      returnedVolumeL: 0,
    });
    expect(first.ok).toBe(true);
    const second = await recordBlReturn(app, users.office, {
      deliveryId: l.value.id,
      returnedOn: '2026-06-03',
    });
    expect(second).toEqual({
      ok: false,
      error: 'ALREADY_RETURNED',
      first: { byUserId: users.plant.id, on: '2026-06-02' },
    });
  });

  it('two at once: exactly one is recorded', async () => {
    const o = await order();
    const l = await load(users.plant, o.id, 2000);
    if (!l.ok) throw new Error('setup');
    const results = await Promise.all(
      [users.plant, users.office, users.plant, users.office].map((u) =>
        recordBlReturn(app, u, { deliveryId: l.value.id, returnedOn: '2026-06-02' }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rows = await inCtx(users.owner, (tx) =>
      tx.query('select 1 from delivery_return where delivery_id = $1', [l.value.id]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses more concrete back than was loaded, a date before the load, an unknown load', async () => {
    const o = await order();
    const l = await load(users.plant, o.id, 1000);
    if (!l.ok) throw new Error('setup');
    expect(
      await recordBlReturn(app, users.plant, {
        deliveryId: l.value.id,
        returnedOn: '2026-06-02',
        returnedVolumeL: 1001,
      }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await recordBlReturn(app, users.plant, { deliveryId: l.value.id, returnedOn: '2026-05-31' }),
    ).toEqual({ ok: false, error: 'INVALID' });
    expect(
      await recordBlReturn(app, users.plant, { deliveryId: randomUUID(), returnedOn: '2026-06-02' }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('support cannot record a return', async () => {
    await expect(
      recordBlReturn(app, users.support, { deliveryId: randomUUID(), returnedOn: '2026-06-02' }),
    ).rejects.toThrow();
  });
});
