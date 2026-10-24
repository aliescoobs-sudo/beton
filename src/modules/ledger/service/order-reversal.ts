import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';
import { needsOldEntryPermission } from '../domain/reversal';
import { parseOrderInput } from '../domain/order';
import { nextDocNumber } from './doc-number';
import {
  type CreatedOrder,
  dbFailure,
  insertOrderRows,
  ledgerParameter,
  type OrderError,
  prepareOrder,
} from './order-service';

export type CancelOrderError =
  OrderError | 'ALREADY_REVERSED' | 'CANNOT_REVERSE_REVERSAL' | 'WINDOW_CLOSED' | 'REASON_REQUIRED';

export interface CancelledOrder {
  reversal: CreatedOrder;
  /** The corrected order, when the cancellation came with one (same transaction). */
  replacement: CreatedOrder | null;
}

/**
 * Cancels an order with a reversing entry (R12, AC-LED-03, AC-LED-17): a new `sales_order` row that negates the original
 * and negated plan items, both pointing at what they reverse, with a mandatory reason, in one transaction; the original
 * is never touched. One audit event ('reverse') carries the reason. An optional replacement order is created in the same
 * transaction, and if it is invalid nothing at all is written.
 */
export async function cancelOrder(
  appPool: pg.Pool,
  actor: SessionUser,
  orderId: string,
  reason: unknown,
  options: { replacement?: unknown },
  deps: { today: string },
): Promise<Result<CancelledOrder, CancelOrderError>> {
  await require(appPool, actor, 'ledger.reverse');
  const text = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
  if (text.length < 3 || text.length > 500) return err('REASON_REQUIRED');
  const replacementInput = options.replacement === undefined ? null : parseOrderInput(options.replacement);
  if (replacementInput && !replacementInput.ok) return err('INVALID');

  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<CancelledOrder, CancelOrderError>> => {
      const original = await tx.query<{ reverses_id: string | null; order_date: string; code: string }>(
        `select reverses_id, to_char(order_date, 'YYYY-MM-DD') as order_date, code from sales_order where id = $1`,
        [orderId],
      );
      if (!original.rows[0]) return err('NOT_FOUND');
      if (original.rows[0].reverses_id) return err('CANNOT_REVERSE_REVERSAL');
      const already = await tx.query('select 1 from sales_order where reverses_id = $1', [orderId]);
      if (already.rowCount) return err('ALREADY_REVERSED');

      const windowDays = await ledgerParameter(tx, 'reversal_window_days');
      if (
        needsOldEntryPermission(original.rows[0].order_date, deps.today, windowDays) &&
        !can(actor.role, 'ledger.reverse_old')
      ) {
        return err('WINDOW_CLOSED');
      }

      // The replacement is prepared first: if it is not valid, nothing has been written yet.
      let prepared = null;
      if (replacementInput?.ok) {
        const p = await prepareOrder(
          tx,
          replacementInput.value,
          deps.today,
          can(actor.role, 'orders.price_override'),
        );
        if (!p.ok) return p;
        prepared = p.value;
      }

      const id = randomUUID();
      const code = await nextDocNumber(tx, 'CMD', deps.today);
      await tx.query(
        `insert into sales_order (id, code, client_id, site_id, zone_id, concrete_type_id, volume_l, order_date,
                                  delivery_date, selling_price_id, unit_price_ht_centimes, vat_rate_bp, total_ht_centimes,
                                  total_vat_centimes, total_ttc_centimes, brought_by_user_id, reverses_id, reason, created_by)
         select $1, $2, client_id, site_id, zone_id, concrete_type_id, -volume_l, order_date, delivery_date,
                selling_price_id, unit_price_ht_centimes, vat_rate_bp, -total_ht_centimes, -total_vat_centimes,
                -total_ttc_centimes, brought_by_user_id, id, $3, $4
           from sales_order where id = $5`,
        [id, code, text, actor.id, orderId],
      );
      await tx.query(
        `insert into payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, reverses_id, created_by)
         select gen_random_uuid(), $1, seq, direction, method, due_date, -amount_centimes, id, $2
           from payment_plan_item where order_id = $3`,
        [id, actor.id, orderId],
      );
      await tx.query(
        `select audit.record('reverse', 'sales_order', $1, jsonb_build_object('reverses', $2::text, 'code', $3::text),
                             jsonb_build_object('reversal_code', $4::text), $5)`,
        [id, orderId, original.rows[0].code, code, text],
      );

      const replacement =
        replacementInput?.ok && prepared
          ? await insertOrderRows(tx, actor, replacementInput.value, prepared, deps.today)
          : null;
      return ok({ reversal: { id, code }, replacement });
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // The unique index on reverses_id: a concurrent second cancellation.
    if (code === '23505') return err('ALREADY_REVERSED');
    return err(dbFailure(error));
  }
}
