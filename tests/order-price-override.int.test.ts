import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createOrder, previewOrder } from '../src/modules/ledger';
import {
  createClient,
  createConcreteType,
  createListPrice,
  fieldCipherFrom,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// ledger L6: AC-LED-12. A price different from the one in force on a single order: the owner only, with a reason that is
// stored and audited; office keeps the price in force, by the service and by the database.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), migrator.end()]));

const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'partner' | 'office' | 'plant' | 'support', SessionUser>;
const inCtx = <T>(user: SessionUser, fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: user.id, role: user.role, requestId: 'test' }, fn);
const rand = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const TODAY = '2026-06-01';

beforeAll(async () => {
  for (const role of ['owner', 'partner', 'office', 'plant', 'support'] as const) {
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
  }
});

async function scene() {
  const type = await createConcreteType(app, users.owner, { code: `V${rand()}`, label: 'Béton dérogation' });
  if (!type.ok) throw new Error(type.error);
  const list = await createListPrice(app, users.owner, {
    concreteTypeId: type.value.id,
    priceHtPerM3Centimes: 78_000,
    effectiveFrom: '2026-01-01',
  });
  if (!list.ok) throw new Error(list.error);
  const client = await createClient(
    app,
    users.office,
    { name: `Client dérogation ${rand()}`, kind: 'company' },
    deps,
  );
  if (!client.ok) throw new Error(client.error);
  return { typeId: type.value.id, clientId: client.value.client.id, listId: list.value.id };
}
const input = (s: { typeId: string; clientId: string }, extra: Record<string, unknown> = {}) => ({
  clientId: s.clientId,
  concreteTypeId: s.typeId,
  dischargeMethod: 'GOULOTTE',
  volumeL: 10_000,
  deliveryDate: '2026-06-05',
  plan: { preset: 'cash' },
  ...extra,
});
const row = async (id: string) =>
  (
    await inCtx(users.owner, (tx) =>
      tx.query(
        `select unit_price_ht_centimes::text as unit, total_ht_centimes::text as ht, total_ttc_centimes::text as ttc, reason,
                selling_price_id::text as list from sales_order where id = $1`,
        [id],
      ),
    )
  ).rows[0];

describe('a price override on one order (AC-LED-12)', () => {
  it('the owner sets another price with a reason: totals follow, the reason is stored and audited, the list price stays the reference', async () => {
    const s = await scene();
    const r = await createOrder(
      app,
      users.owner,
      input(s, {
        priceOverride: { unitPriceHtCentimes: 70_000, reason: 'Remise exceptionnelle chantier test' },
      }),
      { today: TODAY },
    );
    if (!r.ok) throw new Error(r.error);
    expect(await row(r.value.id)).toMatchObject({
      unit: '70000',
      ht: '700000',
      ttc: '840000',
      reason: 'Remise exceptionnelle chantier test',
      list: s.listId,
    });
    const audit = await migrator.query(
      `select after->>'reason' as reason from audit_event where table_name = 'sales_order' and row_id = $1 and action = 'insert'`,
      [r.value.id],
    );
    expect(audit.rows[0]?.reason).toBe('Remise exceptionnelle chantier test');
    // The preview shows the same amounts.
    const preview = await previewOrder(
      app,
      users.owner,
      input(s, {
        priceOverride: { unitPriceHtCentimes: 70_000, reason: 'Remise exceptionnelle chantier test' },
      }),
      { today: TODAY },
    );
    expect(preview.ok && preview.value.totalTtcCentimes).toBe(840_000);
  });

  it('without a reason the owner is refused; with the price in force and no override nothing changes', async () => {
    const s = await scene();
    expect(
      await createOrder(
        app,
        users.owner,
        input(s, { priceOverride: { unitPriceHtCentimes: 70_000, reason: '  ' } }),
        {
          today: TODAY,
        },
      ),
    ).toEqual({ ok: false, error: 'INVALID' });
    const plain = await createOrder(app, users.owner, input(s), { today: TODAY });
    if (!plain.ok) throw new Error(plain.error);
    expect(await row(plain.value.id)).toMatchObject({ unit: '78000', reason: null });
  });

  it('office cannot change the price: refused by the service, and by the database even by direct SQL', async () => {
    const s = await scene();
    expect(
      await createOrder(
        app,
        users.office,
        input(s, { priceOverride: { unitPriceHtCentimes: 70_000, reason: 'Je veux un prix' } }),
        { today: TODAY },
      ),
    ).toEqual({ ok: false, error: 'FORBIDDEN_OVERRIDE' });
    const sql = (reason: string | null, user: SessionUser) => {
      const orderId = randomUUID();
      return inCtx(user, (tx) =>
        tx
          .query(
            `insert into sales_order (id, code, client_id, concrete_type_id, volume_l, order_date, delivery_date, selling_price_id,
                                    unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes,
                                    reason, created_by)
           values ($1, public.next_doc_number('CMD', 2026, 5), $2, $3, 10000, '2026-06-01', '2026-06-05', $4, 70000, 2000,
                   700000, 140000, 840000, $5, $6)`,
            [orderId, s.clientId, s.typeId, s.listId, reason, user.id],
          )
          .then(() =>
            tx.query(
              `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
             values (gen_random_uuid(), $1, 1, 'in', 'cash', '2026-06-05', 840000, $2)`,
              [orderId, user.id],
            ),
          ),
      );
    };
    await expect(sql('Je veux un prix', users.office)).rejects.toMatchObject({ code: '42501' }); // policy: office has no reason
    await expect(sql(null, users.office)).rejects.toMatchObject({ code: '42501' }); // policy: office no longer inserts orders directly (no price oracle)
    await expect(sql(null, users.owner)).rejects.toMatchObject({ code: '23514' }); // the owner needs a reason too
    await expect(sql('Remise', users.owner)).resolves.toBeDefined();
  });

  it('partner, plant and support cannot create an order at all', async () => {
    const s = await scene();
    for (const role of ['partner', 'plant', 'support'] as const) {
      await expect(
        createOrder(
          app,
          users[role],
          input(s, { priceOverride: { unitPriceHtCentimes: 70_000, reason: 'oups ok' } }),
          {
            today: TODAY,
          },
        ),
      ).rejects.toBeDefined();
    }
  });
});
