import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import type { SessionUser } from '@/modules/platform-security';
import {
  parseListPriceInput,
  parseOverrideInput,
  resolveSellingPrice,
  type SellingPrice,
} from '../domain/selling-price';
import { inRequest, isMalformedId, require } from './request';

export type SellingPriceError = 'INVALID' | 'NOT_FOUND' | 'INACTIVE' | 'NOT_AFTER_LATEST' | 'CONFLICT';

interface PriceRow {
  id: string;
  concrete_type_id: string;
  client_id: string | null;
  price_ht_per_m3_centimes: string;
  effective_from: string;
  reason: string | null;
}

// `date` is read as text so the business date is never shifted by a time zone.
export const SELLING_PRICE_COLUMNS = `id, concrete_type_id, client_id, price_ht_per_m3_centimes::text,
  to_char(effective_from, 'YYYY-MM-DD') as effective_from, reason`;

export const toSellingPrice = (row: PriceRow): SellingPrice => ({
  id: row.id,
  concreteTypeId: row.concrete_type_id,
  clientId: row.client_id,
  priceHtPerM3Centimes: Number(row.price_ht_per_m3_centimes),
  effectiveFrom: row.effective_from,
  reason: row.reason,
});

/** Failures of the insert shared by list prices and overrides. */
export function insertFailure(error: unknown): SellingPriceError {
  const code = (error as { code?: string }).code;
  // check_violation (trigger: date not after the previous version) and unique (same date).
  if (code === '23514' || code === '23505') return 'NOT_AFTER_LATEST';
  if (code === '40001') return 'CONFLICT';
  if (code === '22P02' || code === '23503') return 'NOT_FOUND';
  throw error;
}

/** Every selling price version (list and overrides), newest first. Owner, partner and office; never the plant. */
export async function listSellingPrices(
  appPool: pg.Pool,
  actor: SessionUser,
  filter: { concreteTypeId?: string; clientId?: string } = {},
): Promise<SellingPrice[]> {
  await require(appPool, actor, 'selling_prices.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<PriceRow>(
        `select ${SELLING_PRICE_COLUMNS} from selling_price
          where ($1::uuid is null or concrete_type_id = $1) and ($2::uuid is null or client_id = $2)
          order by concrete_type_id, client_id nulls first, effective_from desc`,
        [filter.concreteTypeId ?? null, filter.clientId ?? null],
      ),
    );
    return rows.map(toSellingPrice);
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}

/** Publishes the next list price of a concrete type (insert-only: the old version is untouched). */
export async function createListPrice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<SellingPrice, SellingPriceError>> {
  await require(appPool, actor, 'selling_prices.write');
  const parsed = parseListPriceInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<SellingPrice, SellingPriceError>> => {
      const type = await tx.query<{ status: string }>(`select status from concrete_type where id = $1`, [
        v.concreteTypeId,
      ]);
      if (!type.rows[0]) return err('NOT_FOUND');
      if (type.rows[0].status !== 'active') return err('INACTIVE');
      const { rows } = await tx.query<PriceRow>(
        `insert into selling_price (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, created_by)
         values ($1, $2, null, $3, $4, $5) returning ${SELLING_PRICE_COLUMNS}`,
        [uuidv7(realClock.now()), v.concreteTypeId, v.priceHtPerM3Centimes, v.effectiveFrom, actor.id],
      );
      return ok(toSellingPrice(rows[0] as PriceRow));
    });
  } catch (error) {
    return err(insertFailure(error));
  }
}

/**
 * Publishes the next price override of one client for one concrete type (AC-MD-10): owner/partner only, with a
 * mandatory reason, audited like any price version (the reason is part of the audited row).
 */
export async function createClientOverride(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<SellingPrice, SellingPriceError>> {
  await require(appPool, actor, 'client_price_override.write');
  const parsed = parseOverrideInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<SellingPrice, SellingPriceError>> => {
      const type = await tx.query<{ status: string }>(`select status from concrete_type where id = $1`, [
        v.concreteTypeId,
      ]);
      const client = await tx.query<{ status: string }>(`select status from client where id = $1`, [
        v.clientId,
      ]);
      if (!type.rows[0] || !client.rows[0]) return err('NOT_FOUND');
      if (type.rows[0].status !== 'active' || client.rows[0].status !== 'active') return err('INACTIVE');
      const { rows } = await tx.query<PriceRow>(
        `insert into selling_price
           (id, concrete_type_id, client_id, price_ht_per_m3_centimes, effective_from, reason, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${SELLING_PRICE_COLUMNS}`,
        [
          uuidv7(realClock.now()),
          v.concreteTypeId,
          v.clientId,
          v.priceHtPerM3Centimes,
          v.effectiveFrom,
          v.reason,
          actor.id,
        ],
      );
      return ok(toSellingPrice(rows[0] as PriceRow));
    });
  } catch (error) {
    return err(insertFailure(error));
  }
}

/**
 * The selling price of a type for a client on a business date: the client's override if one is in force, else the list
 * price; `NO_PRICE` (never 0) when neither exists. An order stores the returned id.
 */
export async function resolveSellingPriceFor(
  appPool: pg.Pool,
  actor: SessionUser,
  concreteTypeId: string,
  clientId: string | null,
  date: string,
): Promise<Result<SellingPrice, 'NO_PRICE'>> {
  const versions = await listSellingPrices(appPool, actor, { concreteTypeId });
  return resolveSellingPrice(versions, concreteTypeId, clientId, date);
}
