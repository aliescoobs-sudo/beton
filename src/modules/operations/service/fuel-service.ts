import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { centimes, parseCentimes } from '@/lib/money';
import { isRealDate } from '@/modules/ledger';
import { can, inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import {
  fuelCosts,
  type FuelFill,
  fuelPrice,
  type FuelPrice,
  fuelQuantities,
  type TruckFuelCost,
  type TruckFuelQuantities,
} from '../domain/fuel';
import { litresToMl, parseFuelFillInput, parseFuelPurchaseInput } from '../domain/load-input';

export type FuelError = 'INVALID' | 'NOT_FOUND' | 'ODOMETER' | 'CONFLICT';

function failure(error: unknown): FuelError {
  const e = error as { code?: string; message?: string };
  if (e.code === '23514' && /odometer/.test(e.message ?? '')) return 'ODOMETER';
  if (e.code === '23514') return 'INVALID';
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (e.code === '40001' || e.code === '40P01') return 'CONFLICT';
  throw error;
}

/** A fuel fill (litres, odometer): plant, owner and partner. Quantities only. */
export async function recordFuelFill(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, FuelError>> {
  await require(appPool, actor, 'fuel.write');
  const parsed = parseFuelFillInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const litresMl = litresToMl(v.litres);
  if (litresMl < 1000 || litresMl > 2_000_000) return err('INVALID');
  try {
    return ok(
      await inRequest(appPool, actor, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into fuel_fill (id, truck_id, filled_on, litres_ml, odometer_km, source, created_by)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, v.truckId, v.filledOn, litresMl, v.odometerKm ?? null, v.source, actor.id],
        );
        return { id };
      }),
    );
  } catch (error) {
    return err(failure(error));
  }
}

/** Fuel bought (litres and the total paid): money, owner only. */
export async function recordFuelPurchase(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, FuelError>> {
  await require(appPool, actor, 'fuel.purchase');
  const parsed = parseFuelPurchaseInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const litresMl = litresToMl(v.litres);
  const total = parseCentimes(v.totalMad);
  if (litresMl < 1000 || litresMl > 100_000_000 || total === null || (total as number) <= 0)
    return err('INVALID');
  try {
    return ok(
      await inRequest(appPool, actor, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `insert into fuel_purchase (id, purchased_on, litres_ml, total_centimes, supplier_id, created_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [id, v.purchasedOn, litresMl, total as number, v.supplierId ?? null, actor.id],
        );
        return { id };
      }),
    );
  } catch (error) {
    return err(failure(error));
  }
}

export interface FuelTruckRow extends TruckFuelQuantities {
  truckCode: string;
}

/** The money part of the report: present only in what the owner and support receive. */
export interface FuelMoney {
  price: FuelPrice;
  costs: TruckFuelCost[];
}

export interface FuelReport {
  from: string;
  to: string;
  trucks: FuelTruckRow[];
  /** Owner and support only; the key does not exist for the others. */
  money?: FuelMoney;
}

/** Fuel per truck over [from, to]: quantities for all who read it, the cost per litre, per truck and per m³ for owner and support. */
export async function getFuelReport(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { from: string; to: string },
): Promise<Result<FuelReport, 'INVALID'>> {
  await require(appPool, actor, 'fuel.read');
  const { from, to } = input;
  if (!isRealDate(from) || !isRealDate(to) || to < from) return err('INVALID');
  const withMoney = can(actor.role, 'fuel.money');
  return ok(
    await inRequest(appPool, actor, async (tx) => {
      const fills = await tx.query<{
        truck_id: string;
        date: string;
        litres_ml: number;
        odometer_km: number | null;
      }>(
        `select truck_id, to_char(filled_on, 'YYYY-MM-DD') as date, litres_ml, odometer_km
           from fuel_fill where filled_on between $1 and $2 order by filled_on, created_at`,
        [from, to],
      );
      const loads = await tx.query<{ truck_id: string; volume_l: number }>(
        `select d.truck_id, d.volume_l
           from delivery d left join delivery orig on orig.id = d.reverses_id
          where coalesce(orig.load_date, d.load_date) between $1 and $2`,
        [from, to],
      );
      const trucks = await tx.query<{ id: string; code: string }>(`select id, code from truck`);
      const quantities = fuelQuantities(
        fills.rows.map<FuelFill>((f) => ({
          truckId: f.truck_id,
          date: f.date,
          litresMl: f.litres_ml,
          odometerKm: f.odometer_km,
        })),
        loads.rows.map((l) => ({ truckId: l.truck_id, volumeL: l.volume_l })),
      );
      const code = new Map(trucks.rows.map((t) => [t.id, t.code]));
      const rows: FuelTruckRow[] = quantities
        .filter((q) => q.fills > 0)
        .map((q) => ({ ...q, truckCode: code.get(q.truckId) ?? '?' }))
        .sort((a, b) => a.truckCode.localeCompare(b.truckCode, 'en', { numeric: true }));
      const report: FuelReport = { from, to, trucks: rows };
      if (withMoney) {
        const purchases = await tx.query<{ litres_ml: number; total_centimes: string }>(
          `select litres_ml, total_centimes::text from fuel_purchase where purchased_on between $1 and $2`,
          [from, to],
        );
        const price = fuelPrice(
          purchases.rows.map((p) => ({
            litresMl: p.litres_ml,
            totalCentimes: centimes(Number(p.total_centimes)),
          })),
        );
        report.money = { price, costs: fuelCosts(rows, price) };
      }
      return report;
    }),
  );
}

export interface FuelFillRow {
  id: string;
  truckCode: string;
  filledOn: string;
  litresMl: number;
  odometerKm: number | null;
  source: 'tank' | 'station';
}

/** The latest fills (quantities). */
export async function listFuelFills(
  appPool: pg.Pool,
  actor: SessionUser,
  limit = 30,
): Promise<FuelFillRow[]> {
  await require(appPool, actor, 'fuel.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      truck_code: string;
      filled_on: string;
      litres_ml: number;
      odometer_km: number | null;
      source: 'tank' | 'station';
    }>(
      `select f.id, t.code as truck_code, to_char(f.filled_on, 'YYYY-MM-DD') as filled_on, f.litres_ml, f.odometer_km, f.source
         from fuel_fill f join truck t on t.id = f.truck_id order by f.filled_on desc, f.created_at desc limit $1`,
      [limit],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    truckCode: r.truck_code,
    filledOn: r.filled_on,
    litresMl: r.litres_ml,
    odometerKm: r.odometer_km,
    source: r.source,
  }));
}
