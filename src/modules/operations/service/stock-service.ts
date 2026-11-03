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
import { plantIdOf, usePlant } from '@/modules/master-data';
import { parseOpeningStockInput, parseThresholdInput } from '../domain/load-input';
import {
  DEFAULT_LEAD_DAYS,
  DEFAULT_SAFETY_DAYS,
  reorderThreshold,
  stockStatus,
  type StockStatus,
} from '../domain/stock';

export interface StockLevel {
  componentId: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  /** Integer base units: the sum of every movement (what the office has documented). */
  level: number;
  /**
   * Arrived at the plant and usable for production, not documented by the office yet (§16.7). Never counted twice: when the office
   * documents the receipt it leaves this figure and goes into `level`.
   */
  arrivedPending: number;
  /** What production can draw on now: `level` plus `arrivedPending`. */
  usable: number;
  /** Below which the stock is low; null until the owner sets one. */
  lowThreshold: number | null;
  status: StockStatus;
}

/**
 * The stock of every component and where it stands against its threshold. Plant, owner, partner and support read it.
 * With `plantId` it is the stock of that plant and its own threshold; without, the total of all plants (the sum of the
 * movements, and the sum of each plant's latest threshold). The total always equals the sum of the plants.
 */
export async function getStockLevels(
  appPool: pg.Pool,
  actor: SessionUser,
  opts: { plantId?: string | null } = {},
): Promise<StockLevel[]> {
  await require(appPool, actor, 'stock.read');
  const plantId = opts.plantId ?? null;
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
              (select sum(x.low)::text from (
                 select distinct on (t.plant_id) t.low_qty_base as low from stock_threshold t
                  where t.component_id = c.id and ($1::uuid is null or t.plant_id = $1)
                  order by t.plant_id, t.created_at desc, t.id desc) x) as low
         from component c left join stock_movement m on m.component_id = c.id and ($1::uuid is null or m.plant_id = $1)
        where c.status = 'active' group by c.id order by c.code`,
      [plantId],
    ),
  );
  const pending = await inRequest(appPool, actor, (tx) =>
    tx.query<{ component_id: string; qty_base: string }>(
      'select component_id, qty_base::text from public.stock_arrived_pending($1)',
      [plantId],
    ),
  );
  const waiting = new Map(pending.rows.map((p) => [p.component_id, Number(p.qty_base)]));
  return rows.map((r) => ({
    componentId: r.id,
    nameFr: r.name_fr,
    nameAr: r.name_ar,
    baseUnit: r.base_unit,
    level: Number(r.level),
    arrivedPending: waiting.get(r.id) ?? 0,
    usable: Number(r.level) + (waiting.get(r.id) ?? 0),
    lowThreshold: r.low === null ? null : Number(r.low),
    // Against the threshold what production can draw on counts: booked stock plus what arrived and is usable.
    status: stockStatus(Number(r.level) + (waiting.get(r.id) ?? 0), r.low === null ? null : Number(r.low)),
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
  const plantId = plantIdOf(input);
  try {
    await inRequest(appPool, actor, async (tx) => {
      await usePlant(tx, plantId);
      // One opening per component and plant: with a plant named, its id is the source id.
      await tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, plant_id, created_by)
         values ($1, $2, $3, $4, 'opening', coalesce($6::uuid, $2), $6, $5)`,
        [id, v.componentId, v.date, v.qtyBase, actor.id, plantId],
      );
    });
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_ENTERED');
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    if (e.code === '23514') return err('INVALID');
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
  const plantId = plantIdOf(input);
  try {
    await inRequest(appPool, actor, async (tx) => {
      await usePlant(tx, plantId);
      await tx.query(
        `insert into stock_threshold (id, component_id, low_qty_base, plant_id, created_by) values ($1, $2, $3, $4, $5)`,
        [id, parsed.value.componentId, parsed.value.lowQtyBase, plantId, actor.id],
      );
    });
    return ok({ id });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    if (e.code === '23514') return err('INVALID');
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
  const plantId = plantIdOf(input);
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<StockCountResult, StockCountError>> => {
      await usePlant(tx, plantId);
      // Serialize two counts of the same component and plant: the level read below is the one the correction is computed from.
      await tx.query(
        `select pg_advisory_xact_lock(hashtextextended('stock:count:' || $1::text || coalesce($2::text, ''), 0))`,
        [v.componentId, plantId],
      );
      // A count measures one plant's stock: the level is that plant's movements only.
      const known = await tx.query<{ level: string }>(
        `select coalesce(sum(m.qty_base), 0)::text as level from component c
           left join stock_movement m on m.component_id = c.id and ($2::uuid is null or m.plant_id = $2)
          where c.id = $1 group by c.id`,
        [v.componentId, plantId],
      );
      if (!known.rows[0]) return err('NOT_FOUND');
      const before = Number(known.rows[0].level);
      const difference = v.countedBase - before;
      if (difference === 0) return err('NO_DIFFERENCE');
      await tx.query(
        `insert into stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
         values ($1, $2, $3, $4, 'count_adjustment', $1, $5, $7, $6)`,
        [id, v.componentId, deps.today, difference, v.reason, actor.id, plantId],
      );
      return ok({ id, before, counted: v.countedBase, difference });
    });
  } catch (error) {
    const e = error as { code?: string };
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    if (e.code === '23514') return err('INVALID');
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

export interface ReorderThreshold {
  componentId: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  leadDays: number;
  /** Net quantity consumed over the window at this plant. */
  consumedBase: number;
  windowDays: number;
  /** Derived (null until there is consumption). */
  derived: number | null;
  /** The threshold a person set, when there is one: it wins over the derived one. */
  set: number | null;
}

/**
 * The reorder threshold per component for one plant, derived from the component's lead time and the average daily
 * consumption of the last `windowDays` days (the loads the plant made, net of cancellations). A threshold set by hand
 * (`setStockThreshold`) wins. Quantities only. Plant, owner, partner and support read.
 */
export async function getReorderThresholds(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { plantId: string; today: string; windowDays?: number },
): Promise<ReorderThreshold[]> {
  await require(appPool, actor, 'stock.read');
  const windowDays = input.windowDays ?? 30;
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      name_fr: string;
      name_ar: string;
      base_unit: string;
      lead_time_days: number | null;
      used: string;
      low: string | null;
    }>(
      `select c.id, c.name_fr, c.name_ar, c.base_unit, c.lead_time_days,
              coalesce((select -sum(m.qty_base) from stock_movement m
                         where m.component_id = c.id and m.plant_id = $1 and m.source in ('delivery', 'reversal')
                           and m.movement_date > $2::date - $3::int and m.movement_date <= $2::date), 0)::text as used,
              (select t.low_qty_base::text from stock_threshold t where t.component_id = c.id and t.plant_id = $1
                order by t.created_at desc, t.id desc limit 1) as low
         from component c where c.status = 'active' order by c.code`,
      [input.plantId, input.today, windowDays],
    ),
  );
  return rows.map((r) => {
    const leadDays = r.lead_time_days ?? DEFAULT_LEAD_DAYS;
    const consumedBase = Number(r.used);
    return {
      componentId: r.id,
      nameFr: r.name_fr,
      nameAr: r.name_ar,
      baseUnit: r.base_unit,
      leadDays,
      consumedBase,
      windowDays,
      derived: reorderThreshold({ consumedBase, windowDays, leadDays, safetyDays: DEFAULT_SAFETY_DAYS }),
      set: r.low === null ? null : Number(r.low),
    };
  });
}
