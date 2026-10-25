import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { createOrder, createQuote } from '../src/modules/ledger';
import {
  createClient,
  createConcreteType,
  createListPrice,
  fieldCipherFrom,
} from '../src/modules/master-data';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';

// Review of CP-L4: office creates orders and quotes inside the database (create_order, create_quote); the owner still goes
// through the TypeScript domain functions. Both must give the same figures to the centime, for any volume and price.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
afterAll(() => app.end());
const deps = { cipher: fieldCipherFrom(parseKeyring(env.FIELD_ENCRYPTION_KEYS)) };
const users = {} as Record<'owner' | 'office', SessionUser>;
const inOwner = <T>(fn: (tx: pg.PoolClient) => Promise<T>) =>
  withRlsContext(app, { userId: users.owner.id, role: 'owner', requestId: 'parity' }, fn);
const TODAY = '2026-06-01';
const rand = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

beforeAll(async () => {
  for (const role of ['owner', 'office'] as const)
    users[role] = await realSessionUser(env.DATABASE_URL_MIGRATOR, role);
});

async function scene(price: number) {
  const type = await createConcreteType(app, users.owner, { code: `Y${rand()}`, label: 'Béton parité' });
  if (!type.ok) throw new Error(type.error);
  const list = await createListPrice(app, users.owner, {
    concreteTypeId: type.value.id,
    priceHtPerM3Centimes: price,
    effectiveFrom: '2026-01-01',
  });
  if (!list.ok) throw new Error(list.error);
  const client = await createClient(
    app,
    users.office,
    { name: `Client parité ${rand()}`, kind: 'company' },
    deps,
  );
  if (!client.ok) throw new Error(client.error);
  return { typeId: type.value.id, clientId: client.value.client.id };
}

const figures = (id: string) =>
  inOwner(async (tx) => ({
    order: (
      await tx.query(
        `select volume_l, unit_price_ht_centimes::text, vat_rate_bp, total_ht_centimes::text, total_vat_centimes::text,
                total_ttc_centimes::text, to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, selling_price_id
           from sales_order where id = $1`,
        [id],
      )
    ).rows[0],
    items: (
      await tx.query(
        `select seq, method, to_char(due_date, 'YYYY-MM-DD') as due, amount_centimes::text from payment_plan_item where order_id = $1 order by seq`,
        [id],
      )
    ).rows,
  }));

describe('create_order (SQL, office) equals the domain functions (TS, owner)', () => {
  const planArb = fc.oneof(
    fc.constantFrom('cash', 'advance50', 'installments3', 'cheque30').map((preset) => ({ preset })),
    fc.array(fc.integer({ min: 1, max: 9_000 }), { minLength: 1, maxLength: 4 }).map((raw) => {
      // percentages that add up to 10 000: the last one is what is left
      const parts = raw.slice(0, -1);
      const used = parts.reduce((a, b) => a + b, 0);
      const scale = used > 9_000 ? 9_000 / used : 1;
      const bps = parts.map((p) => Math.max(1, Math.floor(p * scale)));
      bps.push(10_000 - bps.reduce((a, b) => a + b, 0));
      return {
        preset: 'custom',
        items: bps.map((percentBp, i) => ({
          method: (['cheque', 'lcn', 'transfer', 'installment'] as const)[i % 4],
          dueDate: `2026-0${7 + (i % 3)}-1${i}`,
          percentBp,
        })),
      };
    }),
  );

  it('same totals, same plan, to the centime (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 400_000 }),
        fc.integer({ min: 100, max: 9_999_999 }),
        planArb,
        async (volumeL, price, plan) => {
          const s = await scene(price);
          const input = {
            clientId: s.clientId,
            concreteTypeId: s.typeId,
            volumeL,
            deliveryDate: '2026-06-20',
            plan,
          };
          const owner = await createOrder(app, users.owner, input, { today: TODAY });
          const office = await createOrder(app, users.office, input, { today: TODAY });
          // both refuse the same way (a total that rounds to nothing), or both accept
          expect(office.ok, JSON.stringify({ owner, office })).toBe(owner.ok);
          if (!owner.ok || !office.ok) {
            if (!owner.ok && !office.ok) expect(office.error).toBe(owner.error);
            return;
          }
          const a = await figures(owner.value.id);
          const b = await figures(office.value.id);
          expect(b.order).toEqual(a.order);
          expect(b.items).toEqual(a.items);
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);

  it('refuses the same bad plans (sum not 100 %, fixed amounts that do not add up)', async () => {
    const s = await scene(78_000);
    const base = {
      clientId: s.clientId,
      concreteTypeId: s.typeId,
      volumeL: 10_000,
      deliveryDate: '2026-06-20',
    };
    const bad = [
      { preset: 'custom', items: [{ method: 'cash', dueDate: '2026-06-20', percentBp: 9_999 }] },
      { preset: 'custom', items: [{ method: 'cash', dueDate: '2026-06-20', amountCentimes: 100 }] },
      {
        preset: 'custom',
        items: [
          { method: 'cash', dueDate: '2026-06-20', percentBp: 5_000 },
          { method: 'cash', dueDate: '2026-06-21', amountCentimes: 5_000 },
        ],
      },
    ];
    for (const plan of bad) {
      const owner = await createOrder(app, users.owner, { ...base, plan }, { today: TODAY });
      const office = await createOrder(app, users.office, { ...base, plan }, { today: TODAY });
      expect(office.ok).toBe(false);
      expect(owner.ok).toBe(false);
      if (!office.ok && !owner.ok) expect(office.error).toBe(owner.error);
    }
  });
});

describe('create_quote (SQL, office) equals the domain functions (TS, owner)', () => {
  it('same totals and validity (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 400_000 }),
        fc.integer({ min: 100, max: 9_999_999 }),
        fc.option(fc.integer({ min: 1, max: 180 }), { nil: undefined }),
        async (volumeL, price, validDays) => {
          const s = await scene(price);
          const input = { clientId: s.clientId, concreteTypeId: s.typeId, volumeL, validDays };
          const owner = await createQuote(app, users.owner, input, { today: TODAY });
          const office = await createQuote(app, users.office, input, { today: TODAY });
          expect(office.ok).toBe(owner.ok);
          if (!owner.ok || !office.ok) return;
          const read = (id: string) =>
            inOwner(
              async (tx) =>
                (
                  await tx.query(
                    `select volume_l, unit_price_ht_centimes::text, vat_rate_bp, total_ht_centimes::text, total_vat_centimes::text,
                            total_ttc_centimes::text, to_char(valid_until, 'YYYY-MM-DD') as valid_until from quote where id = $1`,
                    [id],
                  )
                ).rows[0],
            );
          expect(await read(office.value.id)).toEqual(await read(owner.value.id));
        },
      ),
      { numRuns: 20 },
    );
  }, 120_000);
});
