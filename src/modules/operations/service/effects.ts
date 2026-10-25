import type pg from 'pg';
import type { Effect } from '@/modules/ledger';
import { stockStatus } from '../domain/stock';

/**
 * The stock facts of a load or a receipt, read back from the movements it wrote in the same transaction: the signed change
 * of every component, the level after it and where that stands against the threshold (what "what did this change" shows).
 */
export async function stockEffects(
  tx: pg.PoolClient,
  source: 'delivery' | 'receipt',
  sourceId: string,
): Promise<Effect[]> {
  const { rows } = await tx.query<{
    name_fr: string;
    name_ar: string;
    base_unit: string;
    delta: string;
    level: string;
    low: string | null;
  }>(
    `select c.name_fr, c.name_ar, c.base_unit, m.qty_base::text as delta,
            (select coalesce(sum(x.qty_base), 0)::text from stock_movement x where x.component_id = c.id) as level,
            coalesce((select t.low_qty_base::text from stock_threshold t where t.component_id = c.id
              order by t.created_at desc, t.id desc limit 1)) as low
       from stock_movement m join component c on c.id = m.component_id
      where m.source = $1 and m.source_id = $2 order by c.code`,
    [source, sourceId],
  );
  return rows.map((r) => ({
    kind: 'stock' as const,
    componentNameFr: r.name_fr,
    componentNameAr: r.name_ar,
    baseUnit: r.base_unit,
    deltaBase: Number(r.delta),
    levelAfter: Number(r.level),
    status: stockStatus(Number(r.level), r.low === null ? null : Number(r.low)),
  }));
}
