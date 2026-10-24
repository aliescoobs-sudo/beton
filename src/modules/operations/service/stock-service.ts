import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { parseOpeningStockInput } from '../domain/load-input';
import { stockStatus, type StockStatus } from '../domain/stock';

export interface StockLevel {
  componentId: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  /** Integer base units: the sum of every movement. */
  level: number;
  /** Below which the stock is low; null until the owner sets one. */
  lowThreshold: number | null;
  status: StockStatus;
}

/** The stock of every component and where it stands against its threshold. Plant, owner, partner and support read it. */
export async function getStockLevels(appPool: pg.Pool, actor: SessionUser): Promise<StockLevel[]> {
  await require(appPool, actor, 'stock.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ id: string; name_fr: string; name_ar: string; base_unit: string; level: string }>(
      `select c.id, c.name_fr, c.name_ar, c.base_unit, coalesce(sum(m.qty_base), 0)::text as level
         from component c left join stock_movement m on m.component_id = c.id
        where c.status = 'active' group by c.id order by c.code`,
    ),
  );
  return rows.map((r) => ({
    componentId: r.id,
    nameFr: r.name_fr,
    nameAr: r.name_ar,
    baseUnit: r.base_unit,
    level: Number(r.level),
    lowThreshold: null,
    status: stockStatus(Number(r.level), null),
  }));
}

export type OpeningStockError = 'INVALID' | 'NOT_FOUND' | 'ALREADY_ENTERED';

/** What the plant holds of a component on the day it starts using the application. Once per component, owner or partner. */
export async function setOpeningStock(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, OpeningStockError>> {
  await require(appPool, actor, 'stock.opening');
  const parsed = parseOpeningStockInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
         values ($1, $2, $3, $4, 'opening', $2, $5)`,
        [id, v.componentId, v.date, v.qtyBase, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_ENTERED');
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}
