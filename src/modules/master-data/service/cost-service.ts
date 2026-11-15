import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

/**
 * T16 G5 (SPEC-cost-margin §9, §11): the data screens of the cost rates, the fuel norms, the delivered transport of a purchase price and the selling price grid.
 * Every read and write goes through a SECURITY DEFINER door that checks the role itself (owner and app_admin); the application has no privilege on the tables.
 * A replacement is a new row (is_assumption = false), never an update. No amount is computed here, none is a constant: values come from the database and from the user.
 */
export type CostError = 'INVALID' | 'NOT_ALLOWED' | 'NOT_AFTER_LAST_VERSION';

export const COST_RATE_KEYS = [
  'diesel_per_l',
  'delivery_other_per_m3',
  'pump_per_m3',
  'plant_per_m3',
  'overhead_per_m3',
] as const;
export const FUEL_KINDS = ['mixer', 'pump', 'external', 'hauler'] as const;
export const DISCHARGE_METHODS = ['GOULOTTE', 'POMPE'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().trim().min(3).max(300);
const reason = z.string().trim().min(3).max(500);
const centimes = z.number().int().min(0).max(1_000_000_000_000);
const rateSchema = z.object({
  key: z.enum(COST_RATE_KEYS),
  valueCentimes: centimes,
  effectiveFrom: day,
  plantId: z.string().uuid().nullable(),
  sourceNote: note,
  reason,
});
const fuelSchema = z
  .object({
    truckKind: z.enum(FUEL_KINDS).nullable(),
    truckId: z.string().uuid().nullable(),
    perTripMl: z.number().int().positive().max(10_000_000).nullable(),
    perHourMl: z.number().int().positive().max(10_000_000).nullable(),
    perKmMl: z.number().int().positive().max(10_000_000).nullable(),
    effectiveFrom: day,
    sourceNote: note,
    reason,
  })
  .refine((v) => (v.truckKind === null) !== (v.truckId === null))
  .refine((v) => v.perTripMl !== null || v.perHourMl !== null || v.perKmMl !== null);
const transportSchema = z.object({
  priceId: z.string().uuid(),
  transportCentimes: centimes,
  sourceNote: note,
  reason,
});
const gridSchema = z.object({
  classId: z.string().uuid(),
  method: z.enum(DISCHARGE_METHODS),
  priceCentimes: z.number().int().positive().max(1_000_000_000),
  effectiveFrom: day,
  reason,
});

function failure(error: unknown): CostError {
  const e = error as { code?: string; message?: string };
  if (e.code === '42501') return 'NOT_ALLOWED';
  if (e.code === '23514' && /must be after the previous version/.test(e.message ?? ''))
    return 'NOT_AFTER_LAST_VERSION';
  if (e.code === '23514' || e.code === '23505' || isMalformedId(error)) return 'INVALID';
  throw error;
}

export interface CostRateRow {
  id: string;
  key: string;
  unit: string;
  valueCentimes: number;
  effectiveFrom: string;
  plantCode: string | null;
  isAssumption: boolean;
  sourceNote: string;
}
export interface FuelNormRow {
  id: string;
  truckKind: string | null;
  truckCode: string | null;
  perTripMl: number | null;
  perHourMl: number | null;
  perKmMl: number | null;
  effectiveFrom: string;
  isAssumption: boolean;
  sourceNote: string;
}
export interface PurchaseTransportRow {
  priceId: string;
  componentCode: string;
  componentName: string;
  unitLabel: string;
  priceCentimes: number;
  effectiveFrom: string;
  transportCentimes: number | null;
  transportIsAssumption: boolean | null;
}
export interface PriceGridRow {
  id: string;
  classCode: string;
  method: string;
  priceCentimes: number;
  effectiveFrom: string;
  isAssumption: boolean;
}
export interface CostScreen {
  rates: CostRateRow[];
  fuel: FuelNormRow[];
  transports: PurchaseTransportRow[];
  grid: PriceGridRow[];
  classes: { id: string; code: string }[];
  trucks: { id: string; code: string }[];
}

const n = (v: string | null): number | null => (v === null ? null : Number(v));

/** Everything the screen shows, for the owner roles; the doors refuse every other role. */
export async function loadCostScreen(appPool: pg.Pool, actor: SessionUser): Promise<CostScreen> {
  await require(appPool, actor, 'costs.manage');
  return inRequest(appPool, actor, async (tx) => {
    const rates = await tx.query<Record<string, string | boolean | null>>(
      `select o_id, o_key, o_unit, o_value_centimes::text v, to_char(o_effective_from, 'YYYY-MM-DD') d, o_plant_code, o_is_assumption, o_source_note from public.cost_rates_list()`,
    );
    const fuel = await tx.query<Record<string, string | boolean | null>>(
      `select o_id, o_truck_kind, o_truck_code, o_per_trip_ml::text trip, o_per_hour_ml::text hour, o_per_km_ml::text km, to_char(o_effective_from, 'YYYY-MM-DD') d, o_is_assumption, o_source_note from public.fuel_norms_list()`,
    );
    const transports = await tx.query<Record<string, string | boolean | null>>(
      `select o_price_id, o_component_code, o_component_name, o_unit_label, o_price_centimes::text price, to_char(o_effective_from, 'YYYY-MM-DD') d, o_transport_centimes::text tr, o_transport_is_assumption from public.purchase_transports_list()`,
    );
    const grid = await tx.query<Record<string, string | boolean | null>>(
      `select o_id, o_class_code, o_method, o_price_centimes::text price, to_char(o_effective_from, 'YYYY-MM-DD') d, o_is_assumption from public.price_grid_list()`,
    );
    const classes = await tx.query<{ id: string; code: string }>(
      `select id, code from concrete_type where status = 'active' order by code`,
    );
    const trucks = await tx.query<{ id: string; code: string }>(
      `select id, code from truck where status = 'active' order by code`,
    );
    return {
      rates: rates.rows.map((r) => ({
        id: String(r.o_id),
        key: String(r.o_key),
        unit: String(r.o_unit),
        valueCentimes: Number(r.v),
        effectiveFrom: String(r.d),
        plantCode: (r.o_plant_code as string | null) ?? null,
        isAssumption: Boolean(r.o_is_assumption),
        sourceNote: String(r.o_source_note),
      })),
      fuel: fuel.rows.map((r) => ({
        id: String(r.o_id),
        truckKind: (r.o_truck_kind as string | null) ?? null,
        truckCode: (r.o_truck_code as string | null) ?? null,
        perTripMl: n(r.trip as string | null),
        perHourMl: n(r.hour as string | null),
        perKmMl: n(r.km as string | null),
        effectiveFrom: String(r.d),
        isAssumption: Boolean(r.o_is_assumption),
        sourceNote: String(r.o_source_note),
      })),
      transports: transports.rows.map((r) => ({
        priceId: String(r.o_price_id),
        componentCode: String(r.o_component_code),
        componentName: String(r.o_component_name),
        unitLabel: String(r.o_unit_label),
        priceCentimes: Number(r.price),
        effectiveFrom: String(r.d),
        transportCentimes: n(r.tr as string | null),
        transportIsAssumption: (r.o_transport_is_assumption as boolean | null) ?? null,
      })),
      grid: grid.rows.map((r) => ({
        id: String(r.o_id),
        classCode: String(r.o_class_code),
        method: String(r.o_method),
        priceCentimes: Number(r.price),
        effectiveFrom: String(r.d),
        isAssumption: Boolean(r.o_is_assumption),
      })),
      classes: classes.rows,
      trucks: trucks.rows,
    };
  });
}

async function write(
  appPool: pg.Pool,
  actor: SessionUser,
  sql: string,
  params: unknown[],
): Promise<Result<true, CostError>> {
  await require(appPool, actor, 'costs.manage');
  try {
    await inRequest(appPool, actor, (tx) => tx.query(sql, params));
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

export async function replaceCostRate(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  const p = rateSchema.safeParse(input);
  if (!p.success) return err<CostError>('INVALID');
  const v = p.data;
  return write(appPool, actor, 'select public.set_cost_rate($1, $2, $3, $4, $5, $6)', [
    v.key,
    v.valueCentimes,
    v.effectiveFrom,
    v.plantId,
    v.sourceNote,
    v.reason,
  ]);
}

export async function replaceFuelNorm(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  const p = fuelSchema.safeParse(input);
  if (!p.success) return err<CostError>('INVALID');
  const v = p.data;
  return write(appPool, actor, 'select public.set_fuel_norm($1, $2, $3, $4, $5, $6, $7, $8)', [
    v.truckKind,
    v.truckId,
    v.perTripMl,
    v.perHourMl,
    v.perKmMl,
    v.effectiveFrom,
    v.sourceNote,
    v.reason,
  ]);
}

export async function replacePurchaseTransport(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  const p = transportSchema.safeParse(input);
  if (!p.success) return err<CostError>('INVALID');
  const v = p.data;
  return write(appPool, actor, 'select public.set_purchase_price_transport($1, $2, $3, $4)', [
    v.priceId,
    v.transportCentimes,
    v.sourceNote,
    v.reason,
  ]);
}

export async function replacePriceGrid(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  const p = gridSchema.safeParse(input);
  if (!p.success) return err<CostError>('INVALID');
  const v = p.data;
  return write(appPool, actor, 'select public.set_price_grid($1, $2, $3, $4, $5)', [
    v.classId,
    v.method,
    v.priceCentimes,
    v.effectiveFrom,
    v.reason,
  ]);
}

/** One grid price in force: what the grid says for a class and a method on a date (a reference, never the price of an order, D239). */
export interface GridPriceInForce {
  classCode: string;
  method: string;
  priceCentimes: number;
  isAssumption: boolean;
}

/**
 * The grid price in force on `today` for every (class, method), for the roles that may read it as the official selling price (owner, app_admin, office_sales).
 * Any other role gets an empty list (no door call). The grid is INFORMATIONAL (D239): nothing here is written into `selling_price`.
 */
export async function listGridInForce(
  appPool: pg.Pool,
  actor: SessionUser,
  today: string,
): Promise<GridPriceInForce[]> {
  if (!can(actor.role, 'grid.read')) return [];
  const rows = await inRequest(appPool, actor, (tx) =>
    tx.query<{ c: string; m: string; p: string; d: string; a: boolean }>(
      `select o_class_code c, o_method m, o_price_centimes::text p, to_char(o_effective_from, 'YYYY-MM-DD') d, o_is_assumption a from public.price_grid_list()`,
    ),
  );
  const best = new Map<string, { c: string; m: string; p: string; d: string; a: boolean }>();
  for (const r of rows.rows) {
    if (r.d > today) continue;
    const key = `${r.c}|${r.m}`;
    const cur = best.get(key);
    if (!cur || r.d > cur.d) best.set(key, r);
  }
  return [...best.values()].map((r) => ({
    classCode: r.c,
    method: r.m,
    priceCentimes: Number(r.p),
    isAssumption: r.a,
  }));
}
