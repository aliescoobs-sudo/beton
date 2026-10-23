import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type Centimes, centimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import {
  parameterOrDefault,
  inRequest,
  isMalformedId,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { type OrderInput, parseOrderInput } from '../domain/order';
import { type PlanItem, type PlanItemInput, splitPlan } from '../domain/plan';
import { presetItems } from '../domain/plan-presets';
import { computeTotals, type Totals } from '../domain/totals';
import { nextDocNumber } from './doc-number';

export type OrderError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'CLIENT_ARCHIVED'
  | 'TYPE_INACTIVE'
  | 'NO_PRICE'
  | 'PLAN_INVALID'
  | 'DELIVERY_BEFORE_ORDER'
  | 'CONFLICT';

/**
 * What an order creation returns to the caller: the identity and the code, never an amount. Office enters orders blind
 * (DECISIONS 81): it cannot read back what it saved, so nothing monetary leaves this function.
 */
export interface CreatedOrder {
  id: string;
  code: string;
}

const dbFailure = (error: unknown): OrderError => {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23514') {
    if (/client is not active/.test(message ?? '')) return 'CLIENT_ARCHIVED';
    if (/concrete type is not active/.test(message ?? '')) return 'TYPE_INACTIVE';
    if (/price is not the one in force/.test(message ?? '')) return 'NO_PRICE';
    if (/payment plan/.test(message ?? '')) return 'PLAN_INVALID';
    return 'INVALID';
  }
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  throw error;
};

interface PreparedOrder {
  clientId: string;
  zoneId: string | null;
  priceId: string;
  unitPrice: Centimes;
  vatRateBp: number;
  totals: Totals;
  plan: PlanItem[];
}

/** Everything an order is made of, computed from the database and the domain functions; writes nothing. */
async function prepareOrder(
  tx: pg.PoolClient,
  v: OrderInput,
  today: string,
): Promise<Result<PreparedOrder, OrderError>> {
  if (v.deliveryDate < today) return err('DELIVERY_BEFORE_ORDER');
  const client = await tx.query<{ status: string; default_zone_id: string | null }>(
    'select status, default_zone_id from client where id = $1',
    [v.clientId],
  );
  if (!client.rows[0]) return err('NOT_FOUND');
  if (client.rows[0].status !== 'active') return err('CLIENT_ARCHIVED');

  let zoneId = v.zoneId;
  if (v.siteId) {
    const site = await tx.query<{ client_id: string; zone_id: string | null }>(
      'select client_id, zone_id from client_site where id = $1',
      [v.siteId],
    );
    if (!site.rows[0] || site.rows[0].client_id !== v.clientId) return err('NOT_FOUND');
    zoneId ??= site.rows[0].zone_id;
  }
  zoneId ??= client.rows[0].default_zone_id;

  const type = await tx.query<{ status: string }>('select status from concrete_type where id = $1', [
    v.concreteTypeId,
  ]);
  if (!type.rows[0]) return err('NOT_FOUND');
  if (type.rows[0].status !== 'active') return err('TYPE_INACTIVE');

  const price = await tx.query<{ id: string; price_ht_per_m3_centimes: string }>(
    'select id, price_ht_per_m3_centimes from public.resolve_selling_price($1, $2, $3)',
    [v.concreteTypeId, v.clientId, today],
  );
  if (!price.rows[0]) return err('NO_PRICE');
  const unitPrice = centimes(Number(price.rows[0].price_ht_per_m3_centimes));

  const vatRateBp = await ledgerParameter(tx, 'vat_rate_bp');
  const totals = computeTotals(v.volumeL, unitPrice, vatRateBp);
  if (!totals.ok) return err('INVALID');

  const items: PlanItemInput[] =
    v.plan.preset === 'custom'
      ? v.plan.items.map((i) => ({
          method: i.method,
          dueDate: i.dueDate,
          share:
            i.percentBp !== undefined
              ? { percentBp: i.percentBp }
              : { amount: centimes(i.amountCentimes as number) },
        }))
      : presetItems(v.plan.preset, { orderDate: today, deliveryDate: v.deliveryDate });
  const plan = splitPlan(totals.value.totalTtc, items);
  if (!plan.ok) return err('PLAN_INVALID');
  return ok({
    clientId: v.clientId,
    zoneId,
    priceId: price.rows[0].id,
    unitPrice,
    vatRateBp,
    totals: totals.value,
    plan: plan.value,
  });
}

/**
 * Creates an order and its payment plan in one transaction (AC-LED-01, AC-LED-02, AC-LED-13, AC-LED-18). The price is
 * resolved by the database for the client on the order date (office cannot read prices), the VAT rate is the parameter
 * in force and is stored on the order, the totals come from the domain function, the plan from a preset or custom
 * shares. `deps.today` is the business date of the request clock.
 */
export async function createOrder(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<CreatedOrder, OrderError>> {
  await require(appPool, actor, 'orders.write');
  const parsed = parseOrderInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;

  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<CreatedOrder, OrderError>> => {
      const prepared = await prepareOrder(tx, v, deps.today);
      if (!prepared.ok) return prepared;
      const p = prepared.value;
      const id = randomUUID();
      const code = await nextDocNumber(tx, 'CMD', deps.today);
      // No RETURNING: office has no SELECT policy on the table (blind entry).
      await tx.query(
        `insert into sales_order (id, code, client_id, site_id, zone_id, concrete_type_id, volume_l, order_date,
                                  delivery_date, selling_price_id, unit_price_ht_centimes, vat_rate_bp,
                                  total_ht_centimes, total_vat_centimes, total_ttc_centimes, brought_by_user_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          code,
          p.clientId,
          v.siteId,
          p.zoneId,
          v.concreteTypeId,
          v.volumeL,
          deps.today,
          v.deliveryDate,
          p.priceId,
          p.unitPrice,
          p.vatRateBp,
          p.totals.totalHt,
          p.totals.totalVat,
          p.totals.totalTtc,
          v.broughtByUserId,
          actor.id,
        ],
      );
      for (const [n, item] of p.plan.entries()) {
        await tx.query(
          `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
           values ($1, $2, $3, 'in', $4, $5, $6, $7)`,
          [randomUUID(), id, n + 1, item.method, item.dueDate, item.amount, actor.id],
        );
      }
      return ok({ id, code });
    });
  } catch (error) {
    return err(dbFailure(error));
  }
}

/** The amounts an order would get, for the roles that may read money (owner): nothing is written. */
export interface OrderPreview {
  unitPriceHtCentimes: number;
  vatRateBp: number;
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  plan: { method: PlanItem['method']; dueDate: string; amountCentimes: number }[];
}

export async function previewOrder(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<OrderPreview, OrderError>> {
  await require(appPool, actor, 'orders.read_money');
  await require(appPool, actor, 'orders.write');
  const parsed = parseOrderInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<OrderPreview, OrderError>> => {
      const prepared = await prepareOrder(tx, parsed.value, deps.today);
      if (!prepared.ok) return prepared;
      const p = prepared.value;
      return ok({
        unitPriceHtCentimes: p.unitPrice,
        vatRateBp: p.vatRateBp,
        totalHtCentimes: p.totals.totalHt,
        totalVatCentimes: p.totals.totalVat,
        totalTtcCentimes: p.totals.totalTtc,
        plan: p.plan.map((i) => ({ method: i.method, dueDate: i.dueDate, amountCentimes: i.amount })),
      });
    });
  } catch (error) {
    return err(dbFailure(error));
  }
}

/** A ledger parameter as the roles that create documents may read it: the stored value over the default. */
async function ledgerParameter(
  tx: pg.PoolClient,
  key: 'vat_rate_bp' | 'reversal_window_days' | 'clearing_delay_days',
): Promise<number> {
  const { rows } = await tx.query<{ value: unknown }>('select public.ledger_parameter($1) as value', [key]);
  return parameterOrDefault(key, rows[0]?.value);
}
