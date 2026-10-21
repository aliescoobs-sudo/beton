import type pg from 'pg';
import { type Centimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import {
  componentCostPerM3,
  parsePurchasePriceInput,
  type PricePoint,
  type PurchasePrice,
} from '../domain/purchase-price';
import { inRequest, isMalformedId, require } from './request';
import { resolveRecetteFor } from './recette-service';

export type PurchasePriceError =
  'INVALID' | 'NOT_FOUND' | 'INACTIVE' | 'UNIT_MISMATCH' | 'NOT_AFTER_LATEST' | 'CONFLICT';

interface PriceRow {
  id: string;
  component_id: string;
  supplier_id: string;
  purchase_unit_id: string;
  price_ht_centimes: string;
  effective_from: string;
}

// `date` is read as text so the business date is never shifted by a time zone.
const COLUMNS = `id, component_id, supplier_id, purchase_unit_id, price_ht_centimes::text,
  to_char(effective_from, 'YYYY-MM-DD') as effective_from`;

const toPrice = (row: PriceRow): PurchasePrice => ({
  id: row.id,
  componentId: row.component_id,
  supplierId: row.supplier_id,
  purchaseUnitId: row.purchase_unit_id,
  priceHtCentimes: Number(row.price_ht_centimes),
  effectiveFrom: row.effective_from,
});

/** Every price version, newest first (optionally one component). Owner, partner and office; never the plant. */
export async function listPurchasePrices(
  appPool: pg.Pool,
  actor: SessionUser,
  componentId?: string,
): Promise<PurchasePrice[]> {
  await require(appPool, actor, 'purchase_prices.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<PriceRow>(
        `select ${COLUMNS} from purchase_price where ($1::uuid is null or component_id = $1)
          order by component_id, effective_from desc`,
        [componentId ?? null],
      ),
    );
    return rows.map(toPrice);
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}

/** Publishes the next price of a component (insert-only: the old version is untouched). */
export async function createPurchasePrice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<PurchasePrice, PurchasePriceError>> {
  await require(appPool, actor, 'purchase_prices.write');
  const parsed = parsePurchasePriceInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<PurchasePrice, PurchasePriceError>> => {
      const component = await tx.query<{ status: string }>(`select status from component where id = $1`, [
        v.componentId,
      ]);
      const supplier = await tx.query<{ status: string }>(`select status from supplier where id = $1`, [
        v.supplierId,
      ]);
      const unit = await tx.query<{ status: string; component_id: string }>(
        `select status, component_id from purchase_unit where id = $1`,
        [v.purchaseUnitId],
      );
      if (!component.rows[0] || !supplier.rows[0] || !unit.rows[0]) return err('NOT_FOUND');
      if (unit.rows[0].component_id !== v.componentId) return err('UNIT_MISMATCH');
      if (
        component.rows[0].status !== 'active' ||
        supplier.rows[0].status !== 'active' ||
        unit.rows[0].status !== 'active'
      )
        return err('INACTIVE');
      const { rows } = await tx.query<PriceRow>(
        `insert into purchase_price
           (id, component_id, supplier_id, purchase_unit_id, price_ht_centimes, effective_from, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
        [
          uuidv7(realClock.now()),
          v.componentId,
          v.supplierId,
          v.purchaseUnitId,
          v.priceHtCentimes,
          v.effectiveFrom,
          actor.id,
        ],
      );
      return ok(toPrice(rows[0] as PriceRow));
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // check_violation (trigger: date not after the previous version) and unique (same date).
    if (code === '23514' || code === '23505') return err('NOT_AFTER_LATEST');
    if (code === '40001') return err('CONFLICT');
    if (code === '22P02') return err('NOT_FOUND');
    throw error;
  }
}

/**
 * STUB (T10): "propose a new version from the last purchase" returns the latest price as it stands. The real proposal
 * (the price of the last purchase invoice) comes with the ledger, which records the purchases.
 */
export async function proposePriceFromLastPurchase(
  appPool: pg.Pool,
  actor: SessionUser,
  componentId: string,
): Promise<PurchasePrice | null> {
  await require(appPool, actor, 'purchase_prices.write');
  return (await listPurchasePrices(appPool, actor, componentId))[0] ?? null;
}

/**
 * Cost of the components of one m³ of `concreteTypeId` on a business date, from the recette and purchase prices in
 * force then (computed, never stored). Owner and partner only: a derived cost is a margin figure (AC-SEC-05).
 */
export async function componentCostPerM3For(
  appPool: pg.Pool,
  actor: SessionUser,
  concreteTypeId: string,
  date: string,
): Promise<Result<Centimes, 'NO_RECETTE' | 'NO_PRICE'>> {
  await require(appPool, actor, 'margins.read');
  const recette = await resolveRecetteFor(appPool, actor, concreteTypeId, date);
  if (!recette.ok) return err(recette.error);
  const componentIds = recette.value.lines.map((l) => l.componentId);
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{ component_id: string; price_ht_centimes: string; effective_from: string; factor: number }>(
      `select p.component_id, p.price_ht_centimes::text, to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
              u.factor_to_base as factor
         from purchase_price p join purchase_unit u on u.id = p.purchase_unit_id
        where p.component_id = any($1::uuid[]) and p.effective_from <= $2`,
      [componentIds, date],
    ),
  );
  const prices: PricePoint[] = rows.map((r) => ({
    componentId: r.component_id,
    priceHtCentimes: Number(r.price_ht_centimes),
    effectiveFrom: r.effective_from,
    factorToBase: r.factor,
  }));
  return componentCostPerM3(recette.value.lines, prices, date);
}
