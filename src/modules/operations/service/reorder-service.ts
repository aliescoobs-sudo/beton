import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';

export type ReorderError = 'INVALID' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'ALREADY_OPEN' | 'NOT_OPEN';
export type ReorderState = 'open' | 'seen' | 'ordered' | 'cancelled';

export interface ReorderRequest {
  id: string;
  plantId: string;
  plantCode: string;
  componentId: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  qtyBase: number;
  neededBy: string;
  reason: string;
  auto: boolean;
  state: ReorderState;
  purchaseCode: string | null;
}

const createSchema = z.object({
  componentId: z.string().uuid(),
  qtyBase: z.number().int().positive().max(1_000_000_000_000),
  neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(3).max(400),
});

/** Maps the database refusals of the reorder doors to a stable code (the doors carry the rules; the code only names them). */
function failure(error: unknown): ReorderError {
  const e = error as { code?: string };
  if (e.code === '23505') return 'ALREADY_OPEN';
  if (e.code === '42501') return 'NOT_ALLOWED';
  if (e.code === '23514' || isMalformedId(error)) return 'INVALID';
  throw error;
}

/** Requests the role may read (the database scopes a plant manager to his plant); quantities only, no price. */
export async function listReorderRequests(appPool: pg.Pool, actor: SessionUser): Promise<ReorderRequest[]> {
  await require(appPool, actor, 'reorder.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      o_id: string;
      o_plant_id: string;
      o_plant_code: string;
      o_component_id: string;
      o_name_fr: string;
      o_name_ar: string;
      o_base_unit: string;
      o_qty: string;
      o_needed_by: string;
      o_reason: string;
      o_auto: boolean;
      o_state: ReorderState;
      o_purchase_code: string | null;
    }>(`select o_id, o_plant_id, o_plant_code, o_component_id, o_name_fr, o_name_ar, o_base_unit, o_qty::text as o_qty,
               to_char(o_needed_by, 'YYYY-MM-DD') as o_needed_by, o_reason, o_auto, o_state, o_purchase_code
          from public.reorder_requests_list()`),
  );
  return rows.map((r) => ({
    id: r.o_id,
    plantId: r.o_plant_id,
    plantCode: r.o_plant_code,
    componentId: r.o_component_id,
    nameFr: r.o_name_fr,
    nameAr: r.o_name_ar,
    baseUnit: r.o_base_unit,
    qtyBase: Number(r.o_qty),
    neededBy: r.o_needed_by,
    reason: r.o_reason,
    auto: r.o_auto,
    state: r.o_state,
    purchaseCode: r.o_purchase_code,
  }));
}

async function run(
  appPool: pg.Pool,
  actor: SessionUser,
  permission: 'reorder.create' | 'reorder.handle' | 'reorder.read',
  sql: string,
  params: unknown[],
): Promise<Result<true, ReorderError>> {
  await require(appPool, actor, permission);
  try {
    await inRequest(appPool, actor, (tx) => tx.query(sql, params));
    return ok(true);
  } catch (error) {
    return err(failure(error));
  }
}

/** The plant manager asks for a component of his own plant (the plant is his scope, never an input). */
export async function createReorderRequest(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<true, ReorderError>> {
  await require(appPool, actor, 'reorder.create');
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  return run(appPool, actor, 'reorder.create', 'select public.create_reorder_request($1, $2, $3, $4)', [
    v.componentId,
    v.qtyBase,
    v.neededBy,
    v.reason,
  ]);
}

export const markReorderSeen = (appPool: pg.Pool, actor: SessionUser, requestId: string) =>
  run(appPool, actor, 'reorder.handle', 'select public.mark_reorder_seen($1)', [requestId]);

/** Converts: links the request to an existing purchase (ACH-...) that orders the component for the plant. */
export const linkReorderToPurchase = (
  appPool: pg.Pool,
  actor: SessionUser,
  requestId: string,
  purchaseCode: string,
) =>
  run(appPool, actor, 'reorder.handle', 'select public.link_reorder_to_purchase($1, $2)', [
    requestId,
    purchaseCode.trim(),
  ]);

export const cancelReorderRequest = (
  appPool: pg.Pool,
  actor: SessionUser,
  requestId: string,
  reason: string,
) =>
  run(appPool, actor, 'reorder.read', 'select public.cancel_reorder_request($1, $2)', [
    requestId,
    reason.trim(),
  ]);
