import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * T17 G11 (SPEC-cost-margin §8; D237): the fuel check. The door (fuel_check: owner and app_admin only) compares, per truck and month, the litres the norm says the truck should burn
 * (frozen per-trip norm of each live BL; per-hour norm times the pumping hours of each pump job) with the litres actually filled (fuel_fill), and flags a truck-month whose measured litres are
 * ABOVE the expected ones by more than the threshold (a cost rate flagged is_assumption, edited on /costs). Millilitres in, basis points out: nothing is a float and nothing is money.
 */
export type FuelCheckError = 'INVALID';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const inputSchema = z.object({ from: day, to: day, plantId: z.string().uuid().nullable().default(null) });

export interface FuelCheckRow {
  month: string;
  truckId: string;
  truckCode: string;
  truckKind: string;
  plantCode: string | null;
  /** trips (mixers, haulers: the per-trip norm of each BL), hours (pumps: the per-hour norm times the pumping time), none (fills only). */
  basis: 'trips' | 'hours' | 'none';
  units: number;
  noNormUnits: number;
  fills: number;
  /** Null when a trip or a job of the month has no norm: a part of the expected litres is not an expected figure. */
  expectedMl: number | null;
  measuredMl: number;
  varianceMl: number | null;
  varianceBp: number | null;
  thresholdBp: number | null;
  thresholdIsAssumption: boolean | null;
  flagged: boolean;
}

export async function loadFuelCheck(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<FuelCheckRow[], FuelCheckError>> {
  await require(appPool, actor, 'fuel_check.read');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  try {
    const rows = await inRequest(appPool, actor, (tx) =>
      tx.query<Record<string, string | number | boolean | null>>(
        `select o_month, o_truck_id, o_truck_code, o_truck_kind, o_plant_code, o_basis, o_units, o_no_norm_units, o_fills,
                o_expected_ml::text exp, o_measured_ml::text meas, o_variance_ml::text var, o_variance_bp, o_threshold_bp, o_threshold_assumption, o_flagged
           from public.fuel_check($1, $2, $3)`,
        [v.from, v.to, v.plantId],
      ),
    );
    const n = (x: unknown) => (x === null || x === undefined ? null : Number(x));
    return ok(
      rows.rows.map((r) => ({
        month: String(r.o_month),
        truckId: String(r.o_truck_id),
        truckCode: String(r.o_truck_code),
        truckKind: String(r.o_truck_kind),
        plantCode: (r.o_plant_code as string | null) ?? null,
        basis: r.o_basis as FuelCheckRow['basis'],
        units: Number(r.o_units),
        noNormUnits: Number(r.o_no_norm_units),
        fills: Number(r.o_fills),
        expectedMl: n(r.exp),
        measuredMl: Number(r.meas),
        varianceMl: n(r.var),
        varianceBp: n(r.o_variance_bp),
        thresholdBp: n(r.o_threshold_bp),
        thresholdIsAssumption: r.o_threshold_assumption === null ? null : Boolean(r.o_threshold_assumption),
        flagged: Boolean(r.o_flagged),
      })),
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23514') return err('INVALID');
    throw error;
  }
}
