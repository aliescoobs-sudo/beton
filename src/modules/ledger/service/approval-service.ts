import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

// R3 (REQUIREMENTS-V1 §4, §5, §12): provisional prices, credit holds and the one approvals inbox. Money is integer centimes
// and is computed by the database; the owner and app_admin decide, the human is always the actor.

export type ApprovalError = 'INVALID' | 'NOT_FOUND' | 'ALREADY_DONE';

export interface PriceCard {
  kind: 'price';
  orderId: string;
  orderCode: string;
  clientCode: string;
  clientName: string;
  volumeL: number;
  /** The reference price the order was made at (HT per m³). */
  unitPriceCentimes: number;
  totalHtCentimes: number;
  createdAt: string;
}
export interface CreditCard {
  kind: 'credit';
  orderId: string;
  orderCode: string;
  clientCode: string;
  clientName: string;
  volumeL: number;
  unitPriceCentimes: number;
  totalHtCentimes: number;
  /** credit_limit: the limit would be exceeded; overdue: the client has an overdue instalment. */
  reason: 'credit_limit' | 'overdue';
  openCentimes: number;
  limitCentimes: number | null;
  createdAt: string;
}
export type ApprovalCard = PriceCard | CreditCard;

interface CardRow {
  kind: 'price' | 'credit';
  order_id: string;
  order_code: string;
  client_code: string;
  client_name: string;
  volume_l: number;
  unit_price_centimes: string;
  total_ht_centimes: string;
  reason: 'credit_limit' | 'overdue' | null;
  open_centimes: string | null;
  limit_centimes: string | null;
  created_at: Date;
}

/** Everything waiting for the owner or app_admin, oldest first. Support reads it (audited as a money view by the page). */
export async function listApprovals(appPool: pg.Pool, actor: SessionUser): Promise<ApprovalCard[]> {
  await require(appPool, actor, 'approvals.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<CardRow>('select * from public.approvals_pending()'),
  );
  return rows.map((r) =>
    r.kind === 'price'
      ? {
          kind: 'price',
          orderId: r.order_id,
          orderCode: r.order_code,
          clientCode: r.client_code,
          clientName: r.client_name,
          volumeL: r.volume_l,
          unitPriceCentimes: Number(r.unit_price_centimes),
          totalHtCentimes: Number(r.total_ht_centimes),
          createdAt: r.created_at.toISOString(),
        }
      : {
          kind: 'credit',
          orderId: r.order_id,
          orderCode: r.order_code,
          clientCode: r.client_code,
          clientName: r.client_name,
          volumeL: r.volume_l,
          unitPriceCentimes: Number(r.unit_price_centimes),
          totalHtCentimes: Number(r.total_ht_centimes),
          reason: r.reason ?? 'credit_limit',
          openCentimes: Number(r.open_centimes ?? 0),
          limitCentimes: r.limit_centimes === null ? null : Number(r.limit_centimes),
          createdAt: r.created_at.toISOString(),
        },
  );
}

function failure(error: unknown): ApprovalError {
  const e = error as { code?: string };
  if (e.code === '23505') return 'ALREADY_DONE';
  if (e.code === '23514') return 'NOT_FOUND';
  if (isMalformedId(error)) return 'NOT_FOUND';
  throw error;
}

const priceInput = z.object({
  orderId: z.uuid(),
  /** The real price (HT per m³, centimes). Absent: the order's reference price is confirmed as it is. */
  unitPriceCentimes: z.number().int().min(1).max(100_000_000).nullish(),
});

/** Confirms the real price of one order. A fresh second factor is required by the caller (sensitive action). */
export async function confirmOrderPrice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ unitPriceCentimes: number }, ApprovalError>> {
  await require(appPool, actor, 'approvals.decide');
  const parsed = priceInput.safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ p: string }>('select public.confirm_order_price($1, $2) as p', [
        parsed.data.orderId,
        parsed.data.unitPriceCentimes ?? null,
      ]),
    );
    return ok({ unitPriceCentimes: Number(rows[0]?.p) });
  } catch (error) {
    return err(failure(error));
  }
}

/** Confirms several orders at their reference price in one go: all or none (one transaction). */
export async function confirmPricesInBulk(
  appPool: pg.Pool,
  actor: SessionUser,
  orderIds: unknown,
): Promise<Result<{ confirmed: number }, ApprovalError>> {
  await require(appPool, actor, 'approvals.decide');
  const parsed = z.array(z.uuid()).min(1).max(200).safeParse(orderIds);
  if (!parsed.success) return err('INVALID');
  try {
    await inRequest(appPool, actor, async (tx) => {
      for (const id of parsed.data) await tx.query('select public.confirm_order_price($1, null)', [id]);
    });
    return ok({ confirmed: parsed.data.length });
  } catch (error) {
    return err(failure(error));
  }
}

/** Releases a held order (credit limit or overdue). The note is optional. */
export async function releaseOrderHold(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { orderId: string; note?: string | null },
): Promise<Result<true, ApprovalError>> {
  await require(appPool, actor, 'approvals.decide');
  if (!z.uuid().safeParse(input.orderId).success || (input.note ?? '').length > 500) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.release_order_hold($1, $2)', [input.orderId, input.note ?? null]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

/** Sets (or, with null, removes) a client's credit limit, in centimes. */
export async function setCreditLimit(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { clientId: string; limitCentimes: number | null },
): Promise<Result<true, ApprovalError>> {
  await require(appPool, actor, 'credit_limit.write');
  const ok_ =
    z.uuid().safeParse(input.clientId).success &&
    (input.limitCentimes === null || (Number.isInteger(input.limitCentimes) && input.limitCentimes > 0));
  if (!ok_) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query('select public.set_client_credit_limit($1, $2)', [input.clientId, input.limitCentimes]),
    );
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

export type OrderApprovalState = 'pending_approval' | 'price_provisional';

/** Orders that wait, by code: two words and no figure. Owner, support and the offices read it. */
export async function getOrderApprovalStates(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<Map<string, OrderApprovalState>> {
  await require(appPool, actor, 'orders.approval_state');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ code: string; state: OrderApprovalState }>(
      'select code, state from public.order_approval_state()',
    ),
  );
  return new Map(rows.map((r) => [r.code, r.state]));
}

export interface ClientStanding {
  clientCode: string;
  /** The client has something to pay. */
  owes: boolean;
  /** At least one instalment is past its date and unpaid. */
  late: boolean;
}

/** The standing of every active client as two flags, never a figure (office_sales and office_purchases, REQUIREMENTS-V1 §3.3). */
export async function getClientStandings(
  appPool: pg.Pool,
  actor: SessionUser,
  deps: { today: string },
): Promise<ClientStanding[]> {
  await require(appPool, actor, 'clients.balance_status');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ client_code: string; owes: boolean; late: boolean }>(
      'select client_code, owes, late from public.client_balance_status($1)',
      [deps.today],
    ),
  );
  return rows.map((r) => ({ clientCode: r.client_code, owes: r.owes, late: r.late }));
}
