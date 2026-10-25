import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { parseOpeningStockInput, parseThresholdInput } from '../domain/load-input';
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
    tx.query<{
      id: string;
      name_fr: string;
      name_ar: string;
      base_unit: string;
      level: string;
      low: string | null;
    }>(
      `select c.id, c.name_fr, c.name_ar, c.base_unit, coalesce(sum(m.qty_base), 0)::text as level,
              coalesce((select t.low_qty_base::text from stock_threshold t where t.component_id = c.id
                order by t.created_at desc, t.id desc limit 1)) as low
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
    lowThreshold: r.low === null ? null : Number(r.low),
    status: stockStatus(Number(r.level), r.low === null ? null : Number(r.low)),
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

export type ThresholdError = 'INVALID' | 'NOT_FOUND';

/** The level below which a component is "low": a new row, the latest one is in force. Owner or partner. */
export async function setStockThreshold(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, ThresholdError>> {
  await require(appPool, actor, 'stock.threshold');
  const parsed = parseThresholdInput(input);
  if (!parsed.ok) return err('INVALID');
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into stock_threshold (id, component_id, low_qty_base, created_by) values ($1, $2, $3, $4)`,
        [id, parsed.value.componentId, parsed.value.lowQtyBase, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

const countSchema = z.object({
  componentId: z.uuid(),
  /** What the physical count found, in the component's base unit (g, mL, L). */
  countedBase: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

export type StockCountError = 'INVALID' | 'NOT_FOUND' | 'NO_DIFFERENCE';

export interface StockCountResult {
  id: string;
  before: number;
  counted: number;
  /** The correcting movement (signed): counted − what the movements said. */
  difference: number;
}

/**
 * The owner corrects a component's stock after a physical count (review of CP-OPS-1-3, point 7): one `count_adjustment`
 * movement for the difference between what was counted and what the movements add up to, with a mandatory reason, audited.
 * Nothing is edited: the history of movements stays, the correction is one more line. Computed by deterministic code.
 */
export async function adjustStockAfterCount(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<StockCountResult, StockCountError>> {
  await require(appPool, actor, 'stock.count');
  const parsed = countSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  const id = randomUUID();
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<StockCountResult, StockCountError>> => {
      // Serialize two counts of the same component: the level read below is the one the correction is computed from.
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('stock:count:' || $1::text, 0))`, [
        v.componentId,
      ]);
      const known = await tx.query<{ level: string }>(
        `select coalesce(sum(m.qty_base), 0)::text as level from component c
           left join stock_movement m on m.component_id = c.id where c.id = $1 group by c.id`,
        [v.componentId],
      );
      if (!known.rows[0]) return err('NOT_FOUND');
      const before = Number(known.rows[0].level);
      const difference = v.countedBase - before;
      if (difference === 0) return err('NO_DIFFERENCE');
      await tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, created_by)
         values ($1, $2, $3, $4, 'count_adjustment', $1, $5, $6)`,
        [id, v.componentId, deps.today, difference, v.reason, actor.id],
      );
      return ok({ id, before, counted: v.countedBase, difference });
    });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

export interface StockAdjustment {
  id: string;
  componentId: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  date: string;
  difference: number;
  reason: string;
}

/** The corrections after a count, newest first. Plant, owner, partner and support read (quantities only). */
export async function listStockAdjustments(appPool: pg.Pool, actor: SessionUser): Promise<StockAdjustment[]> {
  await require(appPool, actor, 'stock.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      component_id: string;
      name_fr: string;
      name_ar: string;
      base_unit: string;
      date: string;
      qty: string;
      reason: string;
    }>(
      `select m.id, c.id as component_id, c.name_fr, c.name_ar, c.base_unit, to_char(m.movement_date, 'YYYY-MM-DD') as date,
              m.qty_base::text as qty, m.reason
         from stock_movement m join component c on c.id = m.component_id
        where m.source = 'count_adjustment' order by m.created_at desc, m.id desc limit 50`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    componentId: r.component_id,
    nameFr: r.name_fr,
    nameAr: r.name_ar,
    baseUnit: r.base_unit,
    date: r.date,
    difference: Number(r.qty),
    reason: r.reason,
  }));
}
