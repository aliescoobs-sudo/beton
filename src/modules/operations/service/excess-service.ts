import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  parameterOrDefault,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { withinTolerance } from './delivery-service';

export interface ExcessView {
  id: string;
  deliveryId: string;
  blNo: string;
  orderCode: string;
  clientCode: string;
  loadDate: string;
  excessL: number;
  /** Litres loaded on the order in all, and the order's volume. */
  loadedL: number;
  orderL: number;
  /** Within the tolerance (parameter `load_excess_tolerance_bp`): a minor excess. Derived on every read. */
  minor: boolean;
  confirmed: boolean;
  confirmedNote: string | null;
}

/**
 * Loads that went past their order, newest first, with whether the owner has confirmed them. A load that was cancelled
 * since no longer counts. Owner, partner and support read (volumes only, no price).
 */
export async function listExcesses(appPool: pg.Pool, actor: SessionUser): Promise<ExcessView[]> {
  await require(appPool, actor, 'deliveries.excess_read');
  const { rows, tolerance } = await inRequest(appPool, actor, async (tx) => {
    // Owner, partner and support all read the parameter table (the plant, which cannot, never lists excesses).
    const param = await tx.query<{ value: unknown }>('select value from parameter where key = $1', [
      'load_excess_tolerance_bp',
    ]);
    const result = await tx.query<{
      id: string;
      delivery_id: string;
      bl_no: string;
      order_code: string;
      client_code: string;
      load_date: string;
      excess_l: number;
      loaded_l: string;
      order_l: number;
      note: string | null;
      confirmed: boolean;
    }>(
      `select x.id, x.delivery_id, d.bl_no, o.code as order_code, o.client_code, to_char(d.load_date, 'YYYY-MM-DD') as load_date,
              x.excess_l, (select coalesce(sum(y.volume_l), 0) from delivery y where y.order_id = d.order_id)::text as loaded_l,
              o.volume_l as order_l, c.note, (c.id is not null) as confirmed
         from delivery_excess x
         join delivery d on d.id = x.delivery_id
         join sales_order_ops o on o.id = d.order_id
         left join delivery_excess_confirmation c on c.excess_id = x.id
        where not exists (select 1 from delivery r where r.reverses_id = d.id)
        order by d.load_date desc, d.bl_no desc`,
    );
    return {
      rows: result.rows,
      tolerance: parameterOrDefault('load_excess_tolerance_bp', param.rows[0]?.value),
    };
  });
  return rows.map((r) => ({
    id: r.id,
    deliveryId: r.delivery_id,
    blNo: r.bl_no,
    orderCode: r.order_code,
    clientCode: r.client_code,
    loadDate: r.load_date,
    excessL: r.excess_l,
    loadedL: Number(r.loaded_l),
    orderL: r.order_l,
    minor: withinTolerance(r.order_l, Number(r.loaded_l), tolerance),
    confirmed: r.confirmed,
    confirmedNote: r.note,
  }));
}

const confirmSchema = z.object({
  excessId: z.uuid(),
  note: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(500))
    .nullish(),
});

export type ConfirmExcessError = 'INVALID' | 'NOT_FOUND' | 'ALREADY_CONFIRMED';

/** The owner confirms that an excess load stands and is billed at the order's price. Once; the route asks for a fresh second factor. */
export async function confirmExcess(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, ConfirmExcessError>> {
  await require(appPool, actor, 'deliveries.excess_confirm');
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into delivery_excess_confirmation (id, excess_id, note, created_by) values ($1, $2, $3, $4)`,
        [id, parsed.data.excessId, parsed.data.note ?? null, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_CONFIRMED');
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
