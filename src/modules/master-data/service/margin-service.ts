import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * T17 G9 (SPEC-cost-margin §6, §10; D241): the margin screen's data. Every figure comes from the two read doors (bl_margin_list, margin_summary: owner and app_admin only, actor first), which read the frozen
 * cost snapshot and the BL's own sale price. Nothing is computed here but the display of what the doors return; the arithmetic twin is operations/domain/cost-arithmetic.ts. No export.
 */
export const MARGIN_GROUPS = ['month', 'plant', 'class', 'method', 'client', 'class_method'] as const;
export type MarginGroup = (typeof MARGIN_GROUPS)[number];
export type MarginError = 'INVALID';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const filterSchema = z.object({
  group: z.enum(MARGIN_GROUPS).default('class_method'),
  from: day.default(null),
  to: day.default(null),
  plantId: z.string().uuid().nullable().default(null),
  classId: z.string().uuid().nullable().default(null),
  method: z.enum(['GOULOTTE', 'POMPE', 'NONE']).nullable().default(null),
  clientId: z.string().uuid().nullable().default(null),
});
export type MarginFilters = z.infer<typeof filterSchema>;

export interface MarginSummaryRow {
  key: string;
  label: string;
  isTotal: boolean;
  blCount: number;
  volumeL: number;
  priceCentimes: number;
  materialsCentimes: number;
  deliveryCentimes: number;
  pumpCentimes: number;
  plantCentimes: number;
  overheadsCentimes: number;
  totalCostCentimes: number;
  m1Centimes: number;
  m2Centimes: number;
  m3Centimes: number;
  m1Bp: number | null;
  m2Bp: number | null;
  m3Bp: number | null;
  incompleteCount: number;
  assumedBlCount: number;
  assumedInputs: number;
}
export interface MarginBlRow {
  snapshotId: string;
  blNo: string;
  loadDate: string;
  plantCode: string | null;
  classCode: string;
  method: string | null;
  clientCode: string;
  clientName: string;
  volumeL: number;
  isReversal: boolean;
  priceCentimes: number;
  materialsCentimes: number;
  deliveryCentimes: number;
  pumpCentimes: number;
  plantCentimes: number;
  overheadsCentimes: number;
  totalCostCentimes: number;
  m1Centimes: number;
  m2Centimes: number;
  m3Centimes: number;
  incomplete: boolean;
  missingKeys: string[];
  usesAssumption: boolean;
}
export interface MarginScreen {
  filters: MarginFilters;
  summary: MarginSummaryRow[];
  total: MarginSummaryRow | null;
  incomplete: MarginBlRow[];
  bls: MarginBlRow[];
  plants: { id: string; code: string }[];
  classes: { id: string; code: string }[];
  clients: { id: string; code: string; name: string }[];
}

type Raw = Record<string, string | number | boolean | string[] | null>;
const n = (v: unknown): number => Number(v ?? 0);
const nb = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const blRow = (r: Raw): MarginBlRow => ({
  snapshotId: String(r.o_snapshot_id),
  blNo: String(r.o_bl_no),
  loadDate: String(r.d),
  plantCode: (r.o_plant_code as string | null) ?? null,
  classCode: String(r.o_class_code),
  method: (r.o_method as string | null) ?? null,
  clientCode: String(r.o_client_code),
  clientName: String(r.o_client_name),
  volumeL: n(r.o_volume_l),
  isReversal: Boolean(r.o_is_reversal),
  priceCentimes: n(r.o_price_centimes),
  materialsCentimes: n(r.o_materials_centimes),
  deliveryCentimes: n(r.o_delivery_centimes),
  pumpCentimes: n(r.o_pump_centimes),
  plantCentimes: n(r.o_plant_centimes),
  overheadsCentimes: n(r.o_overheads_centimes),
  totalCostCentimes: n(r.o_total_cost_centimes),
  m1Centimes: n(r.o_m1_centimes),
  m2Centimes: n(r.o_m2_centimes),
  m3Centimes: n(r.o_m3_centimes),
  incomplete: Boolean(r.o_incomplete),
  missingKeys: (r.o_missing_keys as string[] | null) ?? [],
  usesAssumption: Boolean(r.o_uses_assumption),
});
const sumRow = (r: Raw): MarginSummaryRow => ({
  key: String(r.o_key),
  label: String(r.o_label),
  isTotal: Boolean(r.o_is_total),
  blCount: n(r.o_bl_count),
  volumeL: n(r.o_volume_l),
  priceCentimes: n(r.o_price_centimes),
  materialsCentimes: n(r.o_materials_centimes),
  deliveryCentimes: n(r.o_delivery_centimes),
  pumpCentimes: n(r.o_pump_centimes),
  plantCentimes: n(r.o_plant_centimes),
  overheadsCentimes: n(r.o_overheads_centimes),
  totalCostCentimes: n(r.o_total_cost_centimes),
  m1Centimes: n(r.o_m1_centimes),
  m2Centimes: n(r.o_m2_centimes),
  m3Centimes: n(r.o_m3_centimes),
  m1Bp: nb(r.o_m1_bp),
  m2Bp: nb(r.o_m2_bp),
  m3Bp: nb(r.o_m3_bp),
  incompleteCount: n(r.o_incomplete_count),
  assumedBlCount: n(r.o_assumed_bl_count),
  assumedInputs: n(r.o_assumed_inputs),
});

/** The margin screen for owner and app_admin; the doors refuse every other role (42501) whatever this function does. */
export async function loadMargins(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<MarginScreen, MarginError>> {
  await require(appPool, actor, 'bl_margins.read');
  const parsed = filterSchema.safeParse(input ?? {});
  if (!parsed.success) return err('INVALID');
  const f = parsed.data;
  const args = [f.from, f.to, f.plantId, f.classId, f.method, f.clientId];
  return inRequest(appPool, actor, async (tx) => {
    const summary = await tx.query<Raw>(`select * from public.margin_summary($1, $2, $3, $4, $5, $6, $7)`, [
      f.group,
      ...args,
    ]);
    const list = (scope: string, limit: number) =>
      tx.query<Raw>(
        `select *, to_char(o_load_date, 'YYYY-MM-DD') as d from public.bl_margin_list($1, $2, $3, $4, $5, $6, $7, $8)`,
        [...args, scope, limit],
      );
    const incomplete = await list('incomplete', 500);
    const complete = await list('complete', 200);
    const plants = await tx.query<{ id: string; code: string }>(
      `select id, code from plant where status = 'active' order by code`,
    );
    const classes = await tx.query<{ id: string; code: string }>(
      `select id, code from concrete_type where status = 'active' order by code`,
    );
    const clients = await tx.query<{ id: string; code: string; name: string }>(
      `select id, code, name from client where status = 'active' order by code`,
    );
    const rows = summary.rows.map(sumRow);
    return ok({
      filters: f,
      summary: rows.filter((r) => !r.isTotal),
      total: rows.find((r) => r.isTotal) ?? null,
      incomplete: incomplete.rows.map(blRow),
      bls: complete.rows.map(blRow),
      plants: plants.rows,
      classes: classes.rows,
      clients: clients.rows,
    });
  });
}
